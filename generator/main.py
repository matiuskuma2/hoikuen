"""
あゆっこ保育園 業務自動化システム — Python Generator API v5.0
FastAPI server that receives uploaded files and returns generated ZIP + meta JSON

Architecture:
  Hono (UI/API, port 3000) → HTTP → Python Generator (port 8787)

v5.0 changes:
  - 料金体系を保育料案内PDFに完全準拠
  - 延長時間帯: 7:00-7:30, 20:00-21:00 (18:00廃止)
  - 早朝・延長料金: 年齢別 (0~2歳¥300, 3歳¥200, 4~5歳¥150)
  - 夜間保育料: 月極¥2,500 / 一時¥3,000 (年齢別→一律)
  - 朝食代¥150追加
  - PDF: WQY Micro Heiフォント (数字表示修正)
  - 生年月日ベースの年齢クラス判定
"""

import os
import io
import json
import zipfile
import tempfile
import traceback
import calendar
from datetime import datetime, date as _date_cls
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from parsers.lukumi_parser import parse_lukumi
from parsers.schedule_parser import parse_schedule_plans, parse_multiple_schedules
from parsers.roster_parser import parse_roster
from engine.name_matcher import normalize_name, match_children, generate_submission_report
from engine.usage_calculator import compute_all_usage_facts
from engine.charge_calculator import generate_all_charge_lines, _detect_enrollment_type, get_age_class_from_birth_date
from writers.daily_report_writer import write_daily_report
from writers.billing_writer import write_billing_detail
from writers.pdf_writer import generate_parent_statements
from storage import FileStorage

# === Constants ===
VERSION = "5.0"
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 MB per file


def _get_fiscal_year(year: int, month: int) -> int:
    """年月から年度を計算。4月始まり。"""
    return year if month >= 4 else year - 1


def _apply_age_class_from_birth_date(children: list[dict], year: int, month: int) -> None:
    """
    生年月日から年齢クラスを判定して設定する。
    既にage_classが設定されていない場合のみ適用。
    ★ スケジュールの情報をルクミーより優先する。
    """
    fiscal_year = _get_fiscal_year(year, month)
    for child in children:
        birth_date = child.get("birth_date")
        if birth_date:
            computed_age_class = get_age_class_from_birth_date(birth_date, fiscal_year)
            if computed_age_class is not None:
                # 生年月日が存在する場合は常に上書き（最も信頼性が高い）
                child["age_class"] = computed_age_class

app = FastAPI(title="あゆっこ Generator API", version=VERSION)

# ★ CORS: sandbox/開発環境は全オリジン許可。本番デプロイ時は ALLOWED_ORIGINS 環境変数で制限すること。
_allowed_origins = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
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
    # ★ Input validation: year/month boundary check
    if not (2000 <= year <= 2100):
        raise HTTPException(status_code=400, detail=f"年が範囲外です: {year} (2000-2100)")
    if not (1 <= month <= 12):
        raise HTTPException(status_code=400, detail=f"月が範囲外です: {month} (1-12)")

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

            # ★ v5.0: 生年月日から年齢クラスを判定
            _apply_age_class_from_birth_date(children, year, month)

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
                    is_corruption = "破損検出" in str(write_result.get("error", ""))
                    warnings.append({
                        "level": "error",
                        "child_name": None,
                        "message": f"日報テンプレートの書き込みに失敗: {write_result['error']}",
                        "suggestion": "テンプレートに #REF! エラーが含まれています。Excelで開いて修正してください。日報以外の出力（PDF等）は正常に生成されます。" if is_corruption else "テンプレートファイルを確認してください",
                    })
                    stats["total_errors"] += 1
                warnings.extend(write_result.get("warnings", []))

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
                    is_billing_corruption = "破損検出" in str(billing_result.get("error", ""))
                    if is_billing_corruption:
                        warnings.append({
                            "level": "error",
                            "child_name": None,
                            "message": f"保育料明細テンプレートに破損検出。このファイルはスキップしますが、他の出力は正常に生成されます。",
                            "suggestion": "テンプレートに #REF! エラーが含まれています。Excelで開いて修正してください。",
                        })
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
                # ★ Fix #11: 最終集計 — 途中のインクリメント分 (L231,257) と warnings集計の大きい方を採用
                stats["total_warnings"] = len([w for w in warnings if w.get("level") != "error"])
                stats["total_errors"] = max(
                    stats.get("total_errors", 0),
                    len([w for w in warnings if w.get("level") == "error"])
                )

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
                # ★ traceback はサーバーログにのみ出力。クライアントには返さない（内部情報漏洩防止）
                "error": f"内部エラーが発生しました: {type(e).__name__}: {str(e)}",
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
    lukumi_file: Optional[UploadFile] = File(default=None),
    schedule_files: list[UploadFile] = File(default=[]),
):
    """
    月間ダッシュボード用データ生成。
    カレンダー表示に必要な全情報をJSON返却。
    ZIP生成はしない（軽量）。
    
    ★ lukumi_file はオプション:
      - ルクミー + 予定表 → 実績＋予定の完全ビュー
      - 予定表のみ → 次月の利用予定プレビュー
    """
    # ★ Input validation: year/month boundary check
    if not (2000 <= year <= 2100):
        raise HTTPException(status_code=400, detail=f"年が範囲外です: {year} (2000-2100)")
    if not (1 <= month <= 12):
        raise HTTPException(status_code=400, detail=f"月が範囲外です: {month} (1-12)")

    warnings: list[dict] = []

    try:
        with FileStorage() as storage:
            tmpdir = storage.base_dir

            # Parse Lukumi (optional)
            attendance_records = []
            lukumi_children = []
            if lukumi_file and lukumi_file.filename:
                # ★ Fix #3: サイズチェックを _read_upload_safe 経由で実施
                lukumi_bytes = await _read_upload_safe(lukumi_file, "ルクミーデータ")
                if len(lukumi_bytes) > 0:
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

            # ★ If no lukumi data, build children from schedule names
            #   (予定表のみアップロード → 次月プレビュー用)
            schedule_only_children = []
            if len(lukumi_children) == 0 and len(schedule_child_names) > 0:
                for sname in schedule_child_names:
                    norm_name = normalize_name(sname)
                    child_id = f"sched_{norm_name.replace(' ', '_')}"
                    schedule_only_children.append({
                        "id": child_id,
                        "lukumi_id": child_id,
                        "name": norm_name,
                        "name_norm": norm_name,
                        "name_kana": None,
                        "age_class": None,
                        "enrollment_type": "月極",
                        "child_order": 1,
                        "is_allergy": 0,
                        "birth_date": None,
                        "class_name": "",
                        "has_schedule": True,
                        "schedule_file": sname,
                    })
                children = schedule_only_children
                warnings.append({
                    "level": "info",
                    "child_name": None,
                    "message": f"ルクミーデータなし — 予定表から{len(children)}名の園児を検出しました（予定プレビューモード）",
                    "suggestion": "実績データを表示するにはルクミー登降園データもアップロードしてください",
                })

            # ★ v5.0: 生年月日から年齢クラスを判定
            _apply_age_class_from_birth_date(children, year, month)

            # Compute usage facts
            usage_facts = compute_all_usage_facts(
                children, all_plans, attendance_records, year, month
            )

            # Submission report
            submission_report = generate_submission_report(children, schedule_child_names)

            # ── Build dashboard data ──
            days_in_month = calendar.monthrange(year, month)[1]
            is_schedule_only = len(lukumi_children) == 0  # 予定プレビューモード

            # Daily summary
            daily_summary = []
            for day in range(1, days_in_month + 1):
                day_facts = [f for f in usage_facts if f["day"] == day
                             and f["attendance_status"] in ("present", "late_arrive", "early_leave")]
                plan_only = [f for f in usage_facts if f["day"] == day
                             and f["attendance_status"] == "absent"
                             and f.get("planned_start")]

                # Combine present + plan-only for full daily view
                all_day_facts = day_facts + plan_only

                children_detail = []
                for f in all_day_facts:
                    # Find child info to get class_name and detect enrollment_type
                    child_info = next(
                        (c for c in children if c.get("lukumi_id") == f["child_id"]), {}
                    )
                    enrollment = _detect_enrollment_type(child_info)
                    # In schedule-only mode, mark planned children as "planned" (not "absent")
                    status = f["attendance_status"]
                    if is_schedule_only and status == "absent":
                        status = "planned"
                    children_detail.append({
                        "name": f["child_name"],
                        "child_id": f["child_id"],
                        "class_name": child_info.get("class_name", ""),
                        "age_class": child_info.get("age_class"),
                        "birth_date": child_info.get("birth_date"),
                        "planned_start": f.get("planned_start"),
                        "planned_end": f.get("planned_end"),
                        "actual_checkin": f.get("actual_checkin"),
                        "actual_checkout": f.get("actual_checkout"),
                        "billing_start": f.get("billing_start"),
                        "billing_end": f.get("billing_end"),
                        "billing_minutes": f.get("billing_minutes"),
                        "status": status,
                        "enrollment_type": enrollment,
                        "has_breakfast": f.get("has_breakfast", 0),
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
                d = _date_cls(year, month, day)
                weekdays_jp = ['月', '火', '水', '木', '金', '土', '日']
                weekday = weekdays_jp[d.weekday()]
                is_weekend = d.weekday() >= 5

                # Count children — in schedule-only mode, include plan_only in counts
                count_base = all_day_facts if is_schedule_only else day_facts

                # ★ Age-class breakdown: count by age_class from children_detail
                age_counts = {}
                temp_count = 0
                for cd in children_detail:
                    ac = cd.get("age_class")
                    enroll = cd.get("enrollment_type", "")
                    if enroll == "一時":
                        temp_count += 1
                    elif ac is not None:
                        age_counts[ac] = age_counts.get(ac, 0) + 1

                daily_summary.append({
                    "day": day,
                    "weekday": weekday,
                    "is_weekend": is_weekend,
                    "total_children": len(count_base),
                    "planned_absent": 0 if is_schedule_only else len(plan_only),
                    "total_with_plans": len(all_day_facts),
                    "is_schedule_only": is_schedule_only,
                    "age_0_count": age_counts.get(0, 0),
                    "age_1_count": age_counts.get(1, 0),
                    "age_2_count": age_counts.get(2, 0),
                    "age_3_count": age_counts.get(3, 0),
                    "age_4_count": age_counts.get(4, 0),
                    "age_5_count": age_counts.get(5, 0),
                    "temp_count": temp_count,
                    "breakfast_count": sum(1 for f in count_base if f.get("has_breakfast")),
                    "lunch_count": sum(1 for f in count_base if f.get("has_lunch")),
                    "am_snack_count": sum(1 for f in count_base if f.get("has_am_snack")),
                    "pm_snack_count": sum(1 for f in count_base if f.get("has_pm_snack")),
                    "dinner_count": sum(1 for f in count_base if f.get("has_dinner")),
                    "early_morning_count": sum(1 for f in count_base if f.get("is_early_morning")),
                    "extension_count": sum(1 for f in count_base if f.get("is_extension")),
                    "night_count": sum(1 for f in count_base if f.get("is_night")),
                    "sick_count": sum(1 for f in count_base if f.get("is_sick")),
                    "children": children_detail,
                })

            # Children summary (for sidebar)
            children_summary = []
            for c in children:
                cid = c.get("lukumi_id", "")
                c_facts = [f for f in usage_facts if f["child_id"] == cid
                           and f["attendance_status"] in ("present", "late_arrive", "early_leave")]
                c_plan_days = [f for f in usage_facts if f["child_id"] == cid
                               and f.get("planned_start")]
                enrollment = _detect_enrollment_type(c)
                children_summary.append({
                    "name": c["name"],
                    "child_id": cid,
                    "class_name": c.get("class_name", ""),
                    "age_class": c.get("age_class"),
                    "birth_date": c.get("birth_date"),
                    "enrollment_type": enrollment,
                    "has_schedule": c.get("has_schedule", False),
                    "attendance_days": len(c_facts),
                    "planned_days": len(c_plan_days),
                })

            return {
                "year": year,
                "month": month,
                "days_in_month": days_in_month,
                "total_children": len(children),
                "is_schedule_only": is_schedule_only,
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
