"""
Usage Facts 計算エンジン (Python版) — v3.3

課金ルール (v3.1確定版, min禁止):
  billing_start = planned_start (あれば) else actual_checkin
  billing_end   = max(planned_end, actual_checkout)

  ★ min(planned_start, actual_checkin) は絶対に使わない。
    事故防止のため、startは「予定があれば予定」の一択。
    例: 予定 9:00-15:00, 実績 9:15-15:15 → 課金 9:00-15:15
    例: 予定なし, 実績 10:00-16:00 → 課金 10:00-16:00

給食マーク (MVP仕様):
  希望 = 提供 として「〇」を書き込む。
  希望なし = 空セル。
  ※ 実提供と希望の区別は将来拡張で対応。
"""

from engine.name_matcher import normalize_name

# Default pricing rules
DEFAULT_TIME_BOUNDARIES = {
    "early_start": "07:00",
    "early_end": "07:30",
    "extension_start": "18:00",
    "night_start": "20:00",
}


def to_minutes(time_str: str) -> int:
    """HH:MM → total minutes"""
    parts = time_str.split(":")
    return int(parts[0]) * 60 + int(parts[1])


def format_time_no_leading_zero(time_str: str) -> str:
    """08:12 → 8:12"""
    parts = time_str.split(":")
    h = int(parts[0])
    m = parts[1].zfill(2)
    return f"{h}:{m}"


def compute_all_usage_facts(
    children: list[dict],
    all_plans: dict[str, dict],  # child_name → {day: plan}
    attendance_records: list[dict],
    year: int,
    month: int,
) -> list[dict]:
    """
    Compute usage_facts for all children × all days.
    """
    # Index attendance by (lukumi_id, day)
    att_by_key = {}
    for a in attendance_records:
        key = (a["lukumi_id"], a["day"])
        att_by_key[key] = a
    
    facts = []
    
    for child in children:
        lukumi_id = child.get("lukumi_id", "")
        child_name = child.get("name", "")
        child_norm = normalize_name(child_name)
        
        # Find plans for this child
        child_plans = {}
        for plan_name, plans in all_plans.items():
            if normalize_name(plan_name) == child_norm:
                child_plans = plans
                break
            # Try no-space match
            if normalize_name(plan_name).replace(' ', '') == child_norm.replace(' ', ''):
                child_plans = plans
                break
        
        # Process each day
        import calendar
        days_in_month = calendar.monthrange(year, month)[1]
        
        for day in range(1, days_in_month + 1):
            plan = child_plans.get(day)
            actual = att_by_key.get((lukumi_id, day))
            
            fact = _compute_single_fact(child, plan, actual, year, month, day)
            facts.append(fact)
    
    return facts


def _compute_single_fact(
    child: dict,
    plan: dict | None,
    actual: dict | None,
    year: int,
    month: int,
    day: int,
) -> dict:
    """
    Compute a single usage fact for one child × one day.
    Implements v3.1 billing rules.
    """
    fact = {
        "child_id": child.get("lukumi_id", ""),
        "child_name": child.get("name", ""),
        "year": year,
        "month": month,
        "day": day,
        "billing_start": None,
        "billing_end": None,
        "billing_minutes": None,
        "is_early_morning": 0,
        "is_extension": 0,
        "is_night": 0,
        "is_sick": 0,
        "spot_30min_blocks": 0,
        "has_lunch": 0,
        "has_am_snack": 0,
        "has_pm_snack": 0,
        "has_dinner": 0,
        "meal_allergy": child.get("is_allergy", 0),
        "attendance_status": "absent_no_plan",
        "exception_notes": None,
        "planned_start": plan.get("planned_start") if plan else None,
        "planned_end": plan.get("planned_end") if plan else None,
        "actual_checkin": actual.get("actual_checkin") if actual else None,
        "actual_checkout": actual.get("actual_checkout") if actual else None,
    }
    
    has_plan = plan is not None and plan.get("planned_start") is not None
    has_checkin = actual is not None and actual.get("actual_checkin") is not None
    has_checkout = actual is not None and actual.get("actual_checkout") is not None
    
    # Step 1: Presence check
    if not has_plan and not has_checkin:
        fact["attendance_status"] = "absent_no_plan"
        return fact
    
    if has_plan and not has_checkin:
        fact["attendance_status"] = "absent"
        fact["exception_notes"] = "予定あり・実績なし（欠席）"
        # ★ 予定表の食事フラグをキャリーする（ダッシュボード予定プレビュー用）
        #   実績なしでも予定の食事情報は表示に必要
        fact["has_lunch"] = plan.get("lunch_flag", 0)
        fact["has_am_snack"] = plan.get("am_snack_flag", 0)
        fact["has_pm_snack"] = plan.get("pm_snack_flag", 0)
        fact["has_dinner"] = plan.get("dinner_flag", 0)
        return fact
    
    # Step 2: Billing time (v3.1確定ルール — minは使わない)
    notes = []
    
    if has_plan and has_checkin:
        # ★ billing_start = planned_start（固定）。
        # min(planned_start, actual_checkin) は絶対に使わない。
        billing_start = plan["planned_start"]
        
        # ★ billing_end = max(planned_end, actual_checkout)。
        # 予定と実績の大きい方を取る。
        if has_checkout and plan.get("planned_end"):
            plan_end_min = to_minutes(plan["planned_end"])
            actual_end_min = to_minutes(actual["actual_checkout"])
            billing_end = actual["actual_checkout"] if actual_end_min > plan_end_min else plan["planned_end"]
        elif has_checkout:
            billing_end = actual["actual_checkout"]
        elif plan.get("planned_end"):
            billing_end = plan["planned_end"]
        else:
            billing_end = None
        
        fact["attendance_status"] = "present"
        
        # Early leave: actual checkout > 30min before planned end
        if has_checkout and plan.get("planned_end"):
            diff = to_minutes(plan["planned_end"]) - to_minutes(actual["actual_checkout"])
            if diff > 30:
                fact["attendance_status"] = "early_leave"
        
        # Late arrival: actual checkin > 15min after planned start
        if plan.get("planned_start"):
            diff = to_minutes(actual["actual_checkin"]) - to_minutes(plan["planned_start"])
            if diff > 15:
                fact["attendance_status"] = "late_arrive"
    
    elif not has_plan and has_checkin:
        # Walk-in (no plan)
        billing_start = actual["actual_checkin"]
        billing_end = actual["actual_checkout"] if has_checkout else None
        notes.append("予定表未提出・実績のみ")
        fact["attendance_status"] = "present"
    else:
        return fact
    
    if not billing_end:
        notes.append("降園未記録")
    
    fact["billing_start"] = format_time_no_leading_zero(billing_start)
    fact["billing_end"] = format_time_no_leading_zero(billing_end) if billing_end else None
    
    # Step 3: Billing minutes
    if fact["billing_start"] and fact["billing_end"]:
        mins = to_minutes(fact["billing_end"]) - to_minutes(fact["billing_start"])
        if mins < 0:
            mins = 0
            notes.append("負の利用時間（エラー）")
        fact["billing_minutes"] = mins
    
    # Step 4: Time zone flags
    start_min = to_minutes(fact["billing_start"])
    end_min = to_minutes(fact["billing_end"]) if fact["billing_end"] else None
    
    early_start = to_minutes(DEFAULT_TIME_BOUNDARIES["early_start"])
    early_end = to_minutes(DEFAULT_TIME_BOUNDARIES["early_end"])
    ext_start = to_minutes(DEFAULT_TIME_BOUNDARIES["extension_start"])
    night_start = to_minutes(DEFAULT_TIME_BOUNDARIES["night_start"])
    
    fact["is_early_morning"] = 1 if (start_min < early_end and start_min >= early_start) else 0
    fact["is_extension"] = 1 if (end_min is not None and end_min > ext_start) else 0
    fact["is_night"] = 1 if (end_min is not None and end_min > night_start) else 0
    
    # Step 5: Spot care blocks
    enrollment = child.get("enrollment_type", "月極")
    if enrollment == "一時" and fact["billing_minutes"] is not None:
        import math
        fact["spot_30min_blocks"] = math.ceil(fact["billing_minutes"] / 30)
    
    # Step 6: Meal flags
    # ★ MVP仕様: 予定表の給食希望をそのまま「提供」として扱う。
    #   has_lunch=1 → ◆保育時間に「〇」を書き込む → 給食実数表は数式で自動反映
    #   予定表なし(walk-in)の場合は、在園時間帯から推定
    #   早退で提供時間前に帰った場合はフラグを0に修正
    if fact["attendance_status"] in ("present", "late_arrive"):
        if has_plan:
            fact["has_lunch"] = plan.get("lunch_flag", 0)
            fact["has_am_snack"] = plan.get("am_snack_flag", 0)
            fact["has_pm_snack"] = plan.get("pm_snack_flag", 0)
            fact["has_dinner"] = plan.get("dinner_flag", 0)
        else:
            fact["has_lunch"] = 1 if (start_min <= 720 and (end_min or 0) >= 720) else 0
            fact["has_am_snack"] = 1 if start_min <= 600 else 0
            fact["has_pm_snack"] = 1 if (end_min or 0) >= 900 else 0
            fact["has_dinner"] = 1 if (end_min or 0) >= 1080 else 0
        
        # Adjust for early leave
        if fact["attendance_status"] == "early_leave" and end_min is not None:
            if end_min < 720:
                fact["has_lunch"] = 0
            if end_min < 900:
                fact["has_pm_snack"] = 0
            if end_min < 1080:
                fact["has_dinner"] = 0
    
    if notes:
        fact["exception_notes"] = " / ".join(notes)
    
    return fact
