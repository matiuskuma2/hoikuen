"""
児童利用予定表パーサー — v3.1 Phase B-3
1園児1ファイル、シート"原本" から日別の予定を抽出

構造:
  B6  = 園児氏名
  J1  = 年, M1 = 月
  左半分(日1-15): B12:B26=日付, D=登所, G=降所, J=昼食, K=おやつ, L=夕食
  右半分(日16-31): M12:M27=日付, O=登所, R=降所, U=昼食, V=おやつ, W=夕食

強化点 (B-3):
  - 月不一致時に詳細warning（ファイル名+検出月+対象月）
  - 未突合ファイルに理由を添付
  - 園児名検出失敗時のフォールバック（ファイル名から推測）
  - 食事フラグ欠落時のデフォルト推定
"""

import os
import re
from datetime import datetime, time as dt_time
from openpyxl import load_workbook
from engine.name_matcher import normalize_name


def parse_schedule_plans(file_path: str, target_year: int, target_month: int):
    """
    Parse a single child's schedule plan Excel file.

    Returns:
        (plans, child_name, warnings)

        plans: dict[int, plan_dict] — day → plan
        child_name: str | None
        warnings: list[dict]
    """
    warnings = []
    plans = {}
    child_name = None
    filename = os.path.basename(file_path)

    try:
        wb = load_workbook(file_path, data_only=True, read_only=False)
    except Exception as e:
        warnings.append({
            "level": "error",
            "child_name": None,
            "message": f"予定表を開けません: {filename} ({e})",
            "suggestion": "ファイル形式が正しいか確認してください",
            "file": filename,
        })
        return plans, child_name, warnings

    # Find sheet "原本" or first sheet
    if "原本" in wb.sheetnames:
        ws = wb["原本"]
    else:
        ws = wb.active
        warnings.append({
            "level": "info",
            "child_name": None,
            "message": f"「{filename}」にシート「原本」なし。「{ws.title}」を使用",
            "suggestion": None,
            "file": filename,
        })

    # Read all cells into a dict for random access
    cells = {}
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is not None:
                cells[(cell.row, cell.column)] = cell.value

    wb.close()

    # ── Extract child name ──
    # Primary: B6 (row 6, col 2)
    child_name_raw = cells.get((6, 2))
    if child_name_raw:
        child_name = normalize_name(str(child_name_raw))
    else:
        # Fallback: try B5, C6, D6
        for fallback_pos in [(5, 2), (6, 3), (6, 4)]:
            fallback_val = cells.get(fallback_pos)
            if fallback_val and str(fallback_val).strip():
                child_name = normalize_name(str(fallback_val))
                warnings.append({
                    "level": "info",
                    "child_name": child_name,
                    "message": f"「{filename}」: B6が空のため{_cell_ref(fallback_pos)}から園児名を検出",
                    "suggestion": None,
                    "file": filename,
                })
                break

    if not child_name:
        # Last resort: extract from filename
        name_from_file = _extract_name_from_filename(filename)
        if name_from_file:
            child_name = name_from_file
            warnings.append({
                "level": "warn",
                "child_name": child_name,
                "message": f"「{filename}」: セルから園児名を検出できず、ファイル名から推測",
                "suggestion": "予定表のB6セルに園児名を入力してください",
                "file": filename,
            })
        else:
            warnings.append({
                "level": "error",
                "child_name": None,
                "message": f"「{filename}」: 園児名を検出できません",
                "suggestion": "B6セルに園児名が入力されているか確認してください",
                "file": filename,
            })
            return plans, child_name, warnings

    # ── Check year/month ──
    file_year = _safe_int(cells.get((1, 10)))    # J1
    file_month = _safe_int(cells.get((1, 13)))   # M1

    # Try alternate locations for year/month
    if not file_year:
        for pos in [(1, 11), (2, 10), (1, 9)]:
            v = _safe_int(cells.get(pos))
            if v and 2020 <= v <= 2030:
                file_year = v
                break
    if not file_month:
        for pos in [(1, 14), (2, 13), (1, 12)]:
            v = _safe_int(cells.get(pos))
            if v and 1 <= v <= 12:
                file_month = v
                break

    month_mismatch = False
    if file_year and file_month:
        if file_year != target_year or file_month != target_month:
            month_mismatch = True
            warnings.append({
                "level": "warn",
                "child_name": child_name,
                "message": f"「{filename}」の年月({file_year}年{file_month}月)が対象月({target_year}年{target_month}月)と不一致",
                "suggestion": "正しいファイルか確認してください。このファイルのデータは使用されますが、日付のずれにご注意ください",
                "file": filename,
            })
    elif not file_year or not file_month:
        warnings.append({
            "level": "info",
            "child_name": child_name,
            "message": f"「{filename}」: 年月セル(J1/M1)が空または読み取れません",
            "suggestion": None,
            "file": filename,
        })

    # ── Parse left half: days 1-15 ──
    # B=2(date), D=4(start), G=7(end), J=10(lunch), K=11(snack), L=12(dinner)
    for i in range(15):
        row = 12 + i
        day = _safe_int(cells.get((row, 2)))
        if day is None or day < 1 or day > 31:
            continue

        plan = _extract_plan(cells, row,
                             start_col=4, end_col=7,
                             lunch_col=10, snack_col=11, dinner_col=12)
        if plan:
            plan["day"] = day
            plan["child_name"] = child_name
            plan["source_file"] = filename
            plan["month_mismatch"] = month_mismatch
            plans[day] = plan

    # ── Parse right half: days 16-31 ──
    # M=13(date), O=15(start), R=18(end), U=21(lunch), V=22(snack), W=23(dinner)
    for i in range(16):
        row = 12 + i
        day = _safe_int(cells.get((row, 13)))
        if day is None or day < 1 or day > 31:
            continue

        plan = _extract_plan(cells, row,
                             start_col=15, end_col=18,
                             lunch_col=21, snack_col=22, dinner_col=23)
        if plan:
            plan["day"] = day
            plan["child_name"] = child_name
            plan["source_file"] = filename
            plan["month_mismatch"] = month_mismatch
            plans[day] = plan

    # ── Summary ──
    if len(plans) == 0:
        warnings.append({
            "level": "warn",
            "child_name": child_name,
            "message": f"「{filename}」: 有効な利用予定が0件です",
            "suggestion": "予定表の内容が正しいか確認してください",
            "file": filename,
        })

    return plans, child_name, warnings


def parse_multiple_schedules(
    file_paths: list[tuple[str, str]],  # [(file_path, original_filename), ...]
    target_year: int,
    target_month: int,
) -> tuple[dict[str, dict], list[str], list[dict]]:
    """
    Parse multiple schedule files and aggregate results.

    Returns:
        (all_plans, child_names, all_warnings)

        all_plans: dict[child_name → {day: plan}]
        child_names: list of detected child names
        all_warnings: aggregated warnings
    """
    all_plans = {}
    child_names = []
    all_warnings = []

    for file_path, orig_name in file_paths:
        plans, child_name, file_warnings = parse_schedule_plans(file_path, target_year, target_month)
        all_warnings.extend(file_warnings)

        if child_name:
            child_names.append(child_name)
            if child_name in all_plans:
                # Duplicate schedule for same child
                all_warnings.append({
                    "level": "warn",
                    "child_name": child_name,
                    "message": f"園児「{child_name}」の予定表が複数アップロードされています。後のファイル「{orig_name}」で上書きします",
                    "suggestion": None,
                    "file": orig_name,
                })
            all_plans[child_name] = plans

    return all_plans, child_names, all_warnings


def _extract_plan(cells, row, start_col, end_col, lunch_col, snack_col, dinner_col):
    """Extract a single day's plan from cell values"""
    start = _parse_time_cell(cells.get((row, start_col)))
    end = _parse_time_cell(cells.get((row, end_col)))

    # If no times at all, skip this day
    if start is None and end is None:
        return None

    lunch = _is_flag(cells.get((row, lunch_col)))
    snack = _is_flag(cells.get((row, snack_col)))
    dinner = _is_flag(cells.get((row, dinner_col)))

    return {
        "planned_start": start,
        "planned_end": end,
        "lunch_flag": 1 if lunch else 0,
        "am_snack_flag": 1 if snack else 0,
        "pm_snack_flag": 1 if snack else 0,
        "dinner_flag": 1 if dinner else 0,
    }


def _parse_time_cell(val) -> str | None:
    """Parse a time cell value to HH:MM format"""
    if val is None:
        return None

    if isinstance(val, dt_time):
        return val.strftime("%H:%M")

    if isinstance(val, datetime):
        return val.strftime("%H:%M")

    if isinstance(val, (int, float)):
        if 0 <= val < 1:
            total_min = round(val * 24 * 60)
            h = total_min // 60
            m = total_min % 60
            return f"{h:02d}:{m:02d}"
        # Might be hours (e.g., 9 → 09:00)
        if 0 < val < 24 and val == int(val):
            return f"{int(val):02d}:00"
        return None

    s = str(val).strip()
    if not s:
        return None

    match = re.match(r'(\d{1,2}):(\d{2})', s)
    if match:
        return f"{int(match.group(1)):02d}:{match.group(2)}"

    # Try just a number like "900" → "9:00"
    match = re.match(r'^(\d{1,2})(\d{2})$', s)
    if match:
        h = int(match.group(1))
        m = int(match.group(2))
        if 0 <= h <= 23 and 0 <= m <= 59:
            return f"{h:02d}:{m:02d}"

    return None


def _is_flag(val) -> bool:
    """Check if a cell indicates a meal flag (〇, ○, 1, TRUE, etc)"""
    if val is None:
        return False
    s = str(val).strip()
    return s in ('〇', '○', 'O', 'o', '1', 'TRUE', 'true', '◯', '●', '✓', '✔')


def _safe_int(val) -> int | None:
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _cell_ref(pos: tuple) -> str:
    """Convert (row, col) to Excel cell reference like 'B6'"""
    from openpyxl.utils import get_column_letter
    return f"{get_column_letter(pos[1])}{pos[0]}"


def _extract_name_from_filename(filename: str) -> str | None:
    """Try to extract child name from filename like '田中太郎_予定表.xlsx'"""
    # Remove extension
    name = os.path.splitext(filename)[0]

    # Remove common suffixes
    for suffix in ["_予定表", "_予定", "_利用予定", "予定表", "利用予定表", "_schedule"]:
        name = name.replace(suffix, "")

    # Remove year/month patterns
    name = re.sub(r'\d{4}[年/\-]?\d{1,2}[月]?', '', name)
    name = re.sub(r'\d{1,2}月', '', name)

    # Clean up
    name = name.strip("_- 　")

    if len(name) >= 2:
        return normalize_name(name)
    return None
