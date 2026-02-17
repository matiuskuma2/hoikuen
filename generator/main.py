"""
あゆっこ保育園 業務自動化システム — Python Generator API v3.3
FastAPI server that receives uploaded files and returns generated ZIP + meta JSON

Architecture:
  Hono (UI/API, port 3000) → HTTP → Python Generator (port 8787)

Endpoints:
  POST /generate  — multipart files → ZIP response
  POST /preview   — quick parse + matching check → JSON
  GET  /health    — health check

Phase B integration:
  B-0: Name normalization SSOT
  B-1: Lukumi attendance parser (column auto-detect, validation)
  B-2: Children master parser (roster from template)
  B-3: Schedule plans parser (multiple files, month check)
  B-4: Matching & submission report

v3.2 changes:
  - parse_lukumi now returns 3 values (records, children, warnings)
  - parse_roster now returns 2 values (children, warnings)
  - parse_multiple_schedules aggregates all schedule files
  - Submission report included in _meta.json
  - Template corruption guard (abort on #REF/#VALUE detection)
"""

import os
import io
import json
import zipfile
import tempfile
import traceback
import calendar
from datetime import datetime
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from parsers.lukumi_parser import parse_lukumi
from parsers.schedule_parser import parse_schedule_plans, parse_multiple_schedules
from parsers.roster_parser import parse_roster
from engine.name_matcher import normalize_name, match_children, generate_submission_report
from engine.usage_calculator import compute_all_usage_facts
from engine.charge_calculator import generate_all_charge_lines
from writers.daily_report_writer import write_daily_report
from writers.billing_writer import write_billing_detail
from writers.pdf_writer import generate_parent_statements
from storage import FileStorage

# === Constants ===
VERSION = "3.4"
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB per file

app = FastAPI(title="あゆっこ Generator API", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": VERSION,
        "engine": "python-openpyxl",
        "phase": "B-D (parsers+writers+guard)",
        "timestamp": datetime.now().isoformat(),
    }


async def _read_upload_safe(upload_file: UploadFile, label: str = "file") -> bytes:
    """Read upload file content with size check."""
    content = await upload_file.read()
    if len(content) > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"{label} のサイズが大きすぎます ({len(content) / 1024 / 1024:.1f}MB)。上限: {MAX_UPLOAD_SIZE / 1024 / 1024:.0f}MB"
        )
    return content


@app.post("/generate")
async def generate(
    year: int = Form(...),
    month: int = Form(...),
    lukumi_file: UploadFile = File(...),
    schedule_files: list[UploadFile] = File(default=[]),
    daily_report_template: Optional[UploadFile] = File(default=None),
    billing_template: Optional[UploadFile] = File(default=None),
):
    """
    Main generation endpoint.
    Receives uploaded files, processes them, returns ZIP.
    """
    warnings: list[dict] = []
    stats = {
        "children_total": 0,
        "children_processed": 0,
        "children_skipped": 0,
        "days_in_month": calendar.monthrange(year, month)[1],
        "schedule_files_received": len(schedule_files),
        "schedules_matched": 0,
        "schedules_unmatched": 0,
        "total_warnings": 0,
        "total_errors": 0,
    }

    try:
        with FileStorage() as storage:
            tmpdir = storage.base_dir
            # ═══════════════════════════════════════════
            # Phase 1: PARSING (B-1, B-2, B-3)
            # ═══════════════════════════════════════════

            # ── 1-A: Parse Lukumi attendance data (B-1) ──
            lukumi_bytes = await _read_upload_safe(lukumi_file, "ルクミーデータ")
            lukumi_path = os.path.join(tmpdir, lukumi_file.filename or "lukumi.xlsx")
            with open(lukumi_path, "wb") as f:
                f.write(lukumi_bytes)

            attendance_records, lukumi_children, lukumi_warnings = parse_lukumi(
                lukumi_path, year, month
            )
            warnings.extend(lukumi_warnings)

            # ── 1-B: Parse schedule plans - multiple files (B-3) ──
            schedule_file_paths = []
            for sf in schedule_files:
                sf_bytes = await _read_upload_safe(sf, f"予定表({sf.filename})")
                sf_path = os.path.join(tmpdir, sf.filename or f"schedule_{len(schedule_file_paths)}.xlsx")
                with open(sf_path, "wb") as f:
                    f.write(sf_bytes)
                schedule_file_paths.append((sf_path, sf.filename or "unknown.xlsx"))

            all_plans, schedule_child_names, schedule_warnings = parse_multiple_schedules(
                schedule_file_paths, year, month
            )
            warnings.extend(schedule_warnings)

            # ── 1-C: Parse roster from daily report template (B-2) ──
            roster_children = []
            tmpl_path = None
            if daily_report_template:
                tmpl_bytes = await _read_upload_safe(daily_report_template, "日報テンプレート")
                tmpl_path = os.path.join(tmpdir, daily_report_template.filename or "template.xlsx")
                with open(tmpl_path, "wb") as f:
                    f.write(tmpl_bytes)
                roster_children, roster_warnings = parse_roster(tmpl_path)
                warnings.extend(roster_warnings)

            # ── 1-D: Save billing template ──
            billing_tmpl_path = None
            if billing_template:
                billing_bytes = await _read_upload_safe(billing_template, "明細テンプレート")
                billing_tmpl_path = os.path.join(tmpdir, billing_template.filename or "billing_template.xlsx")
                with open(billing_tmpl_path, "wb") as f:
                    f.write(billing_bytes)

            # ═══════════════════════════════════════════
            # Phase 2: MATCHING (B-0, B-4)
            # ═══════════════════════════════════════════

            children, match_warnings, unmatched = match_children(
                lukumi_children, schedule_child_names, roster_children
            )
            warnings.extend(match_warnings)

            # Generate submission report (B-4)
            submission_report = generate_submission_report(children, schedule_child_names)

            # Add warnings for missing schedules
            for ns in submission_report["not_submitted"]:
                warnings.append({
                    "level": "warn",
                    "child_name": ns["name"],
                    "message": f"利用予定表が未提出: {ns['reason']}",
                    "suggestion": "実績データのみで計算しました",
                })

            stats["children_total"] = len(children)
            stats["schedules_matched"] = submission_report["summary"]["submitted"]
            stats["schedules_unmatched"] = len(unmatched)

            # ═══════════════════════════════════════════
            # Phase 3: CALCULATING
            # ═══════════════════════════════════════════

            usage_facts = compute_all_usage_facts(
                children, all_plans, attendance_records, year, month
            )
            charge_lines = generate_all_charge_lines(children, usage_facts)

            stats["children_processed"] = len(children)
            stats["children_skipped"] = len(unmatched)

            # ═══════════════════════════════════════════
            # Phase 4: GENERATING (Writers)
            # ═══════════════════════════════════════════

            output_files = {}
            fatal_corruption = False

            # ── 4-A: Daily report Excel (if template provided) ──
            if tmpl_path:
                report_path = os.path.join(tmpdir, f"日報_{year}年{month:02d}月.xlsx")
                write_result = write_daily_report(
                    tmpl_path, report_path, children,
                    usage_facts, attendance_records, all_plans,
                    year, month
                )
                if write_result["success"]:
                    output_files["daily_report"] = {
                        "path": report_path,
                        "name": f"日報_{year}年{month:02d}月.xlsx",
                        "purpose": "園内管理用：園児登園確認表・児童実績表・◆保育時間",
                        "category": "university",
                    }
                else:
                    # Check if this is a corruption abort
                    if "破損検出" in str(write_result.get("error", "")):
                        fatal_corruption = True
                    warnings.append({
                        "level": "error",
                        "child_name": None,
                        "message": f"日報テンプレートの書き込みに失敗: {write_result['error']}",
                        "suggestion": "テンプレートファイルを確認してください",
                    })
                    stats["total_errors"] += 1
                warnings.extend(write_result.get("warnings", []))

            # ★ FATAL CORRUPTION GUARD — abort entire job
            if fatal_corruption:
                return JSONResponse(
                    status_code=422,
                    content={
                        "error": "テンプレート破損検出: #REF!/#VALUE! エラーが検出されました。安全のため全出力を中止します。",
                        "fatal": True,
                        "warnings": warnings,
                        "stats": stats,
                        "submission_report": submission_report,
                    }
                )

            # ── 4-B: Billing detail Excel (if template provided) ──
            if billing_tmpl_path and os.path.exists(billing_tmpl_path):
                billing_out_path = os.path.join(tmpdir, f"保育料明細_{year}年{month:02d}月.xlsx")
                billing_result = write_billing_detail(
                    billing_tmpl_path, billing_out_path, children, charge_lines, year, month
                )
                if billing_result and billing_result.get("success"):
                    output_files["billing_detail"] = {
                        "path": billing_out_path,
                        "name": f"保育料明細_{year}年{month:02d}月.xlsx",
                        "purpose": "経理提出用：月次請求金額（数量列のみ更新）",
                        "category": "accounting",
                    }
                elif billing_result:
                    if "破損検出" in str(billing_result.get("error", "")):
                        # Fatal corruption in billing template too
                        return JSONResponse(
                            status_code=422,
                            content={
                                "error": "保育料明細テンプレート破損検出。安全のため全出力を中止します。",
                                "fatal": True,
                                "warnings": warnings,
                                "stats": stats,
                                "submission_report": submission_report,
                            }
                        )
                    warnings.extend(billing_result.get("warnings", []))
                    stats["total_errors"] += 1

            # ── 4-C: Parent statement PDFs ──
            pdf_dir = os.path.join(tmpdir, "pdf")
            os.makedirs(pdf_dir, exist_ok=True)
            pdf_files = generate_parent_statements(
                pdf_dir, children, usage_facts, charge_lines, year, month
            )

            # ═══════════════════════════════════════════
            # Phase 5: PACKAGING (ZIP — 3カテゴリフォルダ構成)
            # ═══════════════════════════════════════════
            # ZIP構成（決め打ち）:
            #   01_園内管理/日報_2026年02月.xlsx
            #   02_経理提出/保育料明細_2026年02月.xlsx
            #   03_保護者配布/利用明細書_田中_太郎_202602.pdf
            #   03_保護者配布/利用明細書_佐藤_花子_202602.pdf
            #   _meta.json

            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                # Category 1: 園内管理 (university)
                for key, info in output_files.items():
                    if info.get("category") == "university" and os.path.exists(info["path"]):
                        zf.write(info["path"], f"01_園内管理/{info['name']}")

                # Category 2: 経理提出 (accounting)
                for key, info in output_files.items():
                    if info.get("category") == "accounting" and os.path.exists(info["path"]):
                        zf.write(info["path"], f"02_経理提出/{info['name']}")

                # Category 3: 保護者配布 (parents)
                for pdf_info in pdf_files:
                    if os.path.exists(pdf_info["path"]):
                        zf.write(pdf_info["path"], f"03_保護者配布/{pdf_info['name']}")

                # Meta JSON (root level)
                stats["total_warnings"] = len([w for w in warnings if w.get("level") != "error"])
                stats["total_errors"] = len([w for w in warnings if w.get("level") == "error"])

                meta = {
                    "generated_at": datetime.now().isoformat(),
                    "version": VERSION,
                    "year": year,
                    "month": month,
                    "stats": stats,
                    "warnings": warnings,
                    "submission_report": submission_report,
                    "output_files": [
                        {"type": k, "name": v["name"], "purpose": v["purpose"],
                         "category": v.get("category"), "folder": f"{'01_園内管理' if v.get('category')=='university' else '02_経理提出'}/{v['name']}"}
                        for k, v in output_files.items()
                    ] + [
                        {"type": "pdf", "name": p["name"], "category": "parents",
                         "folder": f"03_保護者配布/{p['name']}"}
                        for p in pdf_files
                    ],
                    "pdf_count": len(pdf_files),
                    "folder_structure": {
                        "01_園内管理": "園児登園確認表・児童実績表・◆保育時間（日報Excel）",
                        "02_経理提出": "保育料明細（数量列のみ更新済み）",
                        "03_保護者配布": "園児別 利用明細書PDF",
                    },
                }
                zf.writestr("_meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

            zip_buffer.seek(0)

            # Return ZIP
            from urllib.parse import quote
            filename = f"あゆっこ_{year}年{month:02d}月.zip"
            filename_encoded = quote(filename)
            return StreamingResponse(
                zip_buffer,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f"attachment; filename*=UTF-8''{filename_encoded}",
                    "X-Warnings-Count": str(len(warnings)),
                    "X-Children-Processed": str(stats["children_processed"]),
                    "X-Meta-Json": json.dumps({
                        "stats": stats,
                        "submission_report": submission_report,
                    }, ensure_ascii=True),
                }
            )

    except HTTPException:
        raise  # Re-raise HTTP exceptions (like 413) as-is
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"データ形式エラー: {str(e)}",
                "warnings": warnings,
                "stats": stats,
            }
        )
    except MemoryError:
        return JSONResponse(
            status_code=507,
            content={
                "error": "メモリ不足: ファイルが大きすぎます。ファイルサイズを確認してください",
                "warnings": warnings,
                "stats": stats,
            }
        )
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={
                "error": str(e),
                "traceback": traceback.format_exc(),
                "warnings": warnings,
                "stats": stats,
            }
        )


@app.post("/preview")
async def preview(
    year: int = Form(...),
    month: int = Form(...),
    lukumi_file: UploadFile = File(...),
    schedule_files: list[UploadFile] = File(default=[]),
):
    """
    Quick preview: parse files and return matching/warning summary
    without generating output files.
    """
    warnings = []

    try:
        with FileStorage() as storage:
            tmpdir = storage.base_dir
            # Parse lukumi
            lukumi_bytes = await _read_upload_safe(lukumi_file, "ルクミーデータ")
            lukumi_path = os.path.join(tmpdir, "lukumi.xlsx")
            with open(lukumi_path, "wb") as f:
                f.write(lukumi_bytes)
            attendance_records, lukumi_children, lukumi_warnings = parse_lukumi(
                lukumi_path, year, month
            )
            warnings.extend(lukumi_warnings)

            # Parse schedules
            schedule_file_paths = []
            for sf in schedule_files:
                sf_bytes = await _read_upload_safe(sf, f"予定表({sf.filename})")
                sf_path = os.path.join(tmpdir, sf.filename or f"schedule_{len(schedule_file_paths)}.xlsx")
                with open(sf_path, "wb") as f:
                    f.write(sf_bytes)
                schedule_file_paths.append((sf_path, sf.filename or "unknown.xlsx"))

            all_plans, schedule_names, schedule_warnings = parse_multiple_schedules(
                schedule_file_paths, year, month
            )
            warnings.extend(schedule_warnings)

            # Match
            children, match_warnings, unmatched = match_children(
                lukumi_children, schedule_names, []
            )
            warnings.extend(match_warnings)

            # Submission report
            submission_report = generate_submission_report(children, schedule_names)

            return {
                "children_detected": len(children),
                "attendance_records": len(attendance_records),
                "schedule_files": len(schedule_names),
                "submission_report": submission_report,
                "unmatched": unmatched,
                "warnings": warnings,
            }

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "warnings": warnings}
        )


@app.post("/dashboard")
async def dashboard(
    year: int = Form(...),
    month: int = Form(...),
    lukumi_file: UploadFile = File(...),
    schedule_files: list[UploadFile] = File(default=[]),
):
    """
    月間ダッシュボード用データ生成。
    カレンダー表示に必要な全情報をJSON返却。
    ZIP生成はしない（軽量）。
    """
    warnings: list[dict] = []

    try:
        with FileStorage() as storage:
            tmpdir = storage.base_dir

            # Parse Lukumi
            lukumi_bytes = await lukumi_file.read()
            lukumi_path = os.path.join(tmpdir, lukumi_file.filename or "lukumi.xlsx")
            with open(lukumi_path, "wb") as f:
                f.write(lukumi_bytes)
            attendance_records, lukumi_children, lukumi_warnings = parse_lukumi(
                lukumi_path, year, month
            )
            warnings.extend(lukumi_warnings)

            # Parse schedules
            schedule_file_paths = []
            for sf in schedule_files:
                sf_bytes = await _read_upload_safe(sf, f"予定表({sf.filename})")
                sf_path = os.path.join(tmpdir, sf.filename or f"schedule_{len(schedule_file_paths)}.xlsx")
                with open(sf_path, "wb") as f:
                    f.write(sf_bytes)
                schedule_file_paths.append((sf_path, sf.filename or "unknown.xlsx"))

            all_plans, schedule_child_names, schedule_warnings = parse_multiple_schedules(
                schedule_file_paths, year, month
            )
            warnings.extend(schedule_warnings)

            # Match
            children, match_warnings, unmatched = match_children(
                lukumi_children, schedule_child_names, []
            )
            warnings.extend(match_warnings)

            # Compute usage facts
            usage_facts = compute_all_usage_facts(
                children, all_plans, attendance_records, year, month
            )

            # Submission report
            submission_report = generate_submission_report(children, schedule_child_names)

            # ── Build dashboard data ──
            days_in_month = calendar.monthrange(year, month)[1]

            # Daily summary
            daily_summary = []
            for day in range(1, days_in_month + 1):
                day_facts = [f for f in usage_facts if f["day"] == day
                             and f["attendance_status"] in ("present", "late_arrive", "early_leave")]
                plan_only = [f for f in usage_facts if f["day"] == day
                             and f["attendance_status"] == "absent"
                             and f.get("planned_start")]

                children_detail = []
                for f in day_facts:
                    children_detail.append({
                        "name": f["child_name"],
                        "child_id": f["child_id"],
                        "planned_start": f.get("planned_start"),
                        "planned_end": f.get("planned_end"),
                        "actual_checkin": f.get("actual_checkin"),
                        "actual_checkout": f.get("actual_checkout"),
                        "billing_start": f.get("billing_start"),
                        "billing_end": f.get("billing_end"),
                        "billing_minutes": f.get("billing_minutes"),
                        "status": f["attendance_status"],
                        "enrollment_type": next(
                            (c.get("enrollment_type", "月極") for c in children
                             if c.get("lukumi_id") == f["child_id"]), "月極"
                        ),
                        "has_lunch": f.get("has_lunch", 0),
                        "has_am_snack": f.get("has_am_snack", 0),
                        "has_pm_snack": f.get("has_pm_snack", 0),
                        "has_dinner": f.get("has_dinner", 0),
                        "is_early_morning": f.get("is_early_morning", 0),
                        "is_extension": f.get("is_extension", 0),
                        "is_night": f.get("is_night", 0),
                        "is_sick": f.get("is_sick", 0),
                        "exception_notes": f.get("exception_notes"),
                    })

                # Weekday
                import datetime as dt_mod
                d = dt_mod.date(year, month, day)
                weekdays_jp = ['月', '火', '水', '木', '金', '土', '日']
                weekday = weekdays_jp[d.weekday()]
                is_weekend = d.weekday() >= 5

                daily_summary.append({
                    "day": day,
                    "weekday": weekday,
                    "is_weekend": is_weekend,
                    "total_children": len(day_facts),
                    "planned_absent": len(plan_only),
                    "lunch_count": sum(1 for f in day_facts if f.get("has_lunch")),
                    "am_snack_count": sum(1 for f in day_facts if f.get("has_am_snack")),
                    "pm_snack_count": sum(1 for f in day_facts if f.get("has_pm_snack")),
                    "dinner_count": sum(1 for f in day_facts if f.get("has_dinner")),
                    "early_morning_count": sum(1 for f in day_facts if f.get("is_early_morning")),
                    "extension_count": sum(1 for f in day_facts if f.get("is_extension")),
                    "night_count": sum(1 for f in day_facts if f.get("is_night")),
                    "sick_count": sum(1 for f in day_facts if f.get("is_sick")),
                    "children": children_detail,
                })

            # Children summary (for sidebar)
            children_summary = []
            for c in children:
                cid = c.get("lukumi_id", "")
                c_facts = [f for f in usage_facts if f["child_id"] == cid
                           and f["attendance_status"] in ("present", "late_arrive", "early_leave")]
                children_summary.append({
                    "name": c["name"],
                    "child_id": cid,
                    "class_name": c.get("class_name", ""),
                    "age_class": c.get("age_class"),
                    "enrollment_type": c.get("enrollment_type", "月極"),
                    "has_schedule": c.get("has_schedule", False),
                    "attendance_days": len(c_facts),
                })

            return {
                "year": year,
                "month": month,
                "days_in_month": days_in_month,
                "total_children": len(children),
                "daily_summary": daily_summary,
                "children_summary": children_summary,
                "submission_report": submission_report,
                "warnings": warnings,
            }

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "warnings": warnings}
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8787)
