"""
Charge Lines 生成エンジン (Python版)
月次usage_factsを集約して園児ごとの請求明細行を生成
"""

from engine.name_matcher import normalize_name

# Default pricing rules (from 保育料案内)
DEFAULT_PRICING = {
    "monthly_fees": {
        "0~2歳": {"1": 45000, "2": 50000, "3": 54000},
        "3歳":   {"1": 36000, "2": 41000, "3": 45000},
        "4~5歳": {"1": 35000, "2": 39000, "3": 42000},
    },
    "spot_rates": {"0~2歳": 200, "3歳": 200, "4~5歳": 150},
    "early_morning_fee": 300,
    "extension_fee": 300,
    "night_fees": {"0~2歳": 3000, "3歳": 2500, "4~5歳": 2500},
    "sick_fee": 2500,
    "meal_prices": {
        "lunch": 300,
        "am_snack": 50,
        "pm_snack": 100,
        "dinner": 300,
    },
}


def get_age_group(age_class: int | None) -> str:
    if age_class is None:
        return "0~2歳"
    if age_class <= 2:
        return "0~2歳"
    if age_class == 3:
        return "3歳"
    return "4~5歳"


def generate_all_charge_lines(
    children: list[dict],
    usage_facts: list[dict],
    pricing: dict | None = None,
) -> list[dict]:
    """Generate charge_lines for all children."""
    if pricing is None:
        pricing = DEFAULT_PRICING
    
    all_lines = []
    
    for child in children:
        child_id = child.get("lukumi_id", "")
        child_name = child.get("name", "")
        
        # Filter facts for this child
        child_facts = [f for f in usage_facts if f["child_id"] == child_id]
        # Only facts where child was present
        present_facts = [f for f in child_facts 
                        if f["attendance_status"] in ("present", "late_arrive", "early_leave")]
        
        lines = _generate_for_child(child, present_facts, pricing)
        all_lines.extend(lines)
    
    return all_lines


def _generate_for_child(
    child: dict,
    facts: list[dict],
    pricing: dict,
) -> list[dict]:
    lines = []
    child_id = child.get("lukumi_id", "")
    child_name = child.get("name", "")
    year = facts[0]["year"] if facts else 0
    month = facts[0]["month"] if facts else 0
    age_group = get_age_group(child.get("age_class"))
    enrollment = child.get("enrollment_type", "月極")
    child_order = str(child.get("child_order", 1))
    
    # 1. Monthly fee (月極 only)
    if enrollment == "月極":
        monthly_fees = pricing["monthly_fees"].get(age_group, {})
        monthly = monthly_fees.get(child_order, 0)
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "monthly_fee",
            "quantity": 1,
            "unit_price": monthly,
            "subtotal": monthly,
            "notes": f"{age_group} 第{child_order}子",
        })
    
    # 2. Spot care (一時 only)
    if enrollment == "一時":
        total_blocks = sum(f.get("spot_30min_blocks", 0) for f in facts)
        unit = pricing["spot_rates"].get(age_group, 200)
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "spot_care",
            "quantity": total_blocks,
            "unit_price": unit,
            "subtotal": total_blocks * unit,
            "notes": f"30分×{total_blocks}回",
        })
    
    # 3. Early morning
    early_count = sum(1 for f in facts if f.get("is_early_morning"))
    if early_count > 0:
        fee = pricing["early_morning_fee"]
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "early_morning",
            "quantity": early_count,
            "unit_price": fee,
            "subtotal": early_count * fee,
            "notes": None,
        })
    
    # 4. Extension (18:00-20:00, not night)
    ext_count = sum(1 for f in facts if f.get("is_extension") and not f.get("is_night"))
    if ext_count > 0:
        fee = pricing["extension_fee"]
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "extension",
            "quantity": ext_count,
            "unit_price": fee,
            "subtotal": ext_count * fee,
            "notes": None,
        })
    
    # 5. Night (20:00+)
    night_count = sum(1 for f in facts if f.get("is_night"))
    if night_count > 0:
        fee = pricing["night_fees"].get(age_group, 2500)
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "night",
            "quantity": night_count,
            "unit_price": fee,
            "subtotal": night_count * fee,
            "notes": None,
        })
    
    # 6. Sick care
    sick_count = sum(1 for f in facts if f.get("is_sick"))
    if sick_count > 0:
        fee = pricing["sick_fee"]
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "sick",
            "quantity": sick_count,
            "unit_price": fee,
            "subtotal": sick_count * fee,
            "notes": None,
        })
    
    # 7. Meals
    meal_types = [
        ("lunch", "has_lunch", "昼食"),
        ("am_snack", "has_am_snack", "朝おやつ"),
        ("pm_snack", "has_pm_snack", "午後おやつ"),
        ("dinner", "has_dinner", "夕食"),
    ]
    for charge_type, flag, label in meal_types:
        count = sum(1 for f in facts if f.get(flag))
        if count > 0:
            price = pricing["meal_prices"].get(charge_type, 0)
            lines.append({
                "child_id": child_id,
                "child_name": child_name,
                "year": year,
                "month": month,
                "charge_type": charge_type,
                "quantity": count,
                "unit_price": price,
                "subtotal": count * price,
                "notes": None,
            })
    
    return lines
