"""
Charge Lines 生成エンジン (Python版) — v4.0
月次usage_factsを集約して園児ごとの請求明細行を生成

課金ルール (v4.0 確定):
  - 一時預かり（クラス名に「●歳」が含まれない）:
    * 保育料 = ¥0（無料）
    * 一時保育料（30分単位）は発生しない
    * 早朝/延長/夜間/病児料は利用時課金
    * 食事代は利用時課金
  - 月極（クラス名に「●歳」が含まれる）:
    * 月額保育料（年齢・第N子で異なる）
    * 一時保育料は発生しない
    * 早朝/延長/夜間/病児料は利用時課金
    * 食事代は利用時課金

enrollment_type 判定:
  ルクミーのクラス名（A列）で判定:
    - "●歳" パターン（例: "0歳", "1歳", "3歳"）→ 月極
    - それ以外（例: "一時預かり", "一時"）→ 一時
"""

from engine.name_matcher import normalize_name
import re

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
        
        # ── Determine enrollment_type from class_name ──
        # ルクミーのクラス名（A列）で判定:
        #   "0歳", "1歳", etc → 月極
        #   "一時預かり", "一時", or anything without "●歳" → 一時
        enrollment = _detect_enrollment_type(child)
        
        # Filter facts for this child
        child_facts = [f for f in usage_facts if f["child_id"] == child_id]
        # Only facts where child was present
        present_facts = [f for f in child_facts 
                        if f["attendance_status"] in ("present", "late_arrive", "early_leave")]
        
        lines = _generate_for_child(child, present_facts, pricing, enrollment)
        all_lines.extend(lines)
    
    return all_lines


def _detect_enrollment_type(child: dict) -> str:
    """
    クラス名から enrollment_type を判定。
    "●歳" パターン → "月極"（月額保育料が発生）
    それ以外 → "一時"（保育料¥0）
    """
    class_name = child.get("class_name", "")
    enrollment_from_data = child.get("enrollment_type", "")
    
    # Check class_name for age pattern like "0歳", "1歳", "2歳", "3歳", "4歳", "5歳"
    if class_name and re.match(r'^\d歳', class_name):
        return "月極"
    
    # Check if explicitly set to 一時
    if "一時" in class_name:
        return "一時"
    
    # Fallback to existing enrollment_type
    if enrollment_from_data == "一時":
        return "一時"
    
    return enrollment_from_data or "月極"


def _generate_for_child(
    child: dict,
    facts: list[dict],
    pricing: dict,
    enrollment: str,
) -> list[dict]:
    """
    Generate charge lines for a single child.
    
    v4.0 課金ルール:
      - 一時預かり: 保育料=¥0、一時保育料なし、早朝/延長/夜間/病児/食事は利用時課金
      - 月極: 月額保育料、一時保育料なし、早朝/延長/夜間/病児/食事は利用時課金
    """
    lines = []
    child_id = child.get("lukumi_id", "")
    child_name = child.get("name", "")
    year = facts[0]["year"] if facts else 0
    month = facts[0]["month"] if facts else 0
    age_group = get_age_group(child.get("age_class"))
    child_order = str(child.get("child_order", 1))
    
    # 1. Monthly fee (月極 only)
    if enrollment == "月極":
        monthly_fees = pricing["monthly_fees"].get(age_group, {})
        monthly = monthly_fees.get(child_order, 0)
        if monthly > 0:
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
    
    # 2. 一時預かり: 保育料¥0 (明示的に0円の行を出力して明確にする)
    if enrollment == "一時":
        lines.append({
            "child_id": child_id,
            "child_name": child_name,
            "year": year,
            "month": month,
            "charge_type": "spot_care",
            "quantity": len(facts),
            "unit_price": 0,
            "subtotal": 0,
            "notes": f"一時預かり保育料: ¥0 ({len(facts)}日利用)",
        })
    
    # ★ 以下は enrollment_type に関係なく、利用時に課金
    
    # 3. Early morning (both 月極 and 一時)
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
    
    # 6. Sick care (both 月極 and 一時 — 電話予約、打刻なし、手動入力)
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
    
    # 7. Meals (both 月極 and 一時)
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
