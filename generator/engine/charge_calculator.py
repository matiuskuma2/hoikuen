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
from datetime import date


def get_age_class_from_birth_date(birth_date_str: str | None, fiscal_year: int) -> int | None:
    """
    生年月日と年度から年齢クラスを判定する。
    
    年齢クラス区分（保育料案内準拠）:
      0歳児: 当年度 4/2 以降生まれ（= 2024/4/2 以降 if fiscal_year=2025）
      1歳児: 前年度 4/2 ～ 当年度 4/1
      2歳児: 前々年度 4/2 ～ 前年度 4/1
      3歳児: 3年前 4/2 ～ 前々年度 4/1
      4歳児: 4年前 4/2 ～ 3年前 4/1
      5歳児: 5年前 4/2 ～ 4年前 4/1
    
    例（2025年度）:
      0歳児: 2024/4/2 以降
      1歳児: 2023/4/2 ～ 2024/4/1
      2歳児: 2022/4/2 ～ 2023/4/1
    
    Args:
        birth_date_str: 生年月日 (YYYY-MM-DD format)
        fiscal_year: 年度 (4月始まり。2026年1月→2025年度)
    
    Returns:
        年齢クラス (0-5) or None if cannot determine
    """
    if not birth_date_str:
        return None
    
    try:
        if isinstance(birth_date_str, date):
            birth = birth_date_str
        else:
            birth = date.fromisoformat(str(birth_date_str)[:10])
    except (ValueError, TypeError):
        return None
    
    # 年度開始日 = 4/2（4/1生まれは前年度扱い）
    # 各クラスの生年月日範囲を判定
    # 0歳児: fiscal_year-1年 4/2 以降生まれ
    # 1歳児: fiscal_year-2年 4/2 ～ fiscal_year-1年 4/1
    # ...
    for age_class in range(6):  # 0~5歳
        year_start = fiscal_year - 1 - age_class
        try:
            range_start = date(year_start, 4, 2)
        except ValueError:
            continue
        
        if birth >= range_start:
            return age_class
    
    return 5  # 5歳児以上は5歳児クラス

# Default pricing rules (from 保育料案内 PDF)
# ★ 保育料案内に完全準拠（v5.0）
DEFAULT_PRICING = {
    "monthly_fees": {
        "0~2歳": {"1": 45000, "2": 50000, "3": 54000},
        "3歳":   {"1": 36000, "2": 41000, "3": 45000},
        "4~5歳": {"1": 35000, "2": 39000, "3": 42000},
    },
    # ★ 一時保育料: 3歳のみ¥200/30分。0〜2歳と4歳は保育料案内PDFで空欄→¥0
    "spot_rates": {"0~2歳": 200, "3歳": 200, "4~5歳": 150},
    # ★ 早朝・延長保育料は年齢別（保育料案内PDF準拠）
    #   0〜2歳: ¥300, 3歳: ¥200, 4歳: ¥150
    "early_morning_fees": {"0~2歳": 300, "3歳": 200, "4~5歳": 150},
    "extension_fees":     {"0~2歳": 300, "3歳": 200, "4~5歳": 150},
    # ★ 夜間保育料: 一時=¥3,000、月極=¥2,500（年齢によらず一律）
    "night_fee_monthly": 2500,
    "night_fee_temp": 3000,
    "sick_fee": 2500,
    "meal_prices": {
        "breakfast": 150,   # ★ 追加: 朝食 ¥150/食
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
    # ★ Fix #6: facts が空の場合の安全なアクセス
    if not facts:
        return lines  # No attendance → no charges
    year = facts[0]["year"]
    month = facts[0]["month"]
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
    
    # 3. Early morning (both 月極 and 一時) — 年齢別料金
    early_count = sum(1 for f in facts if f.get("is_early_morning"))
    if early_count > 0:
        fee = pricing["early_morning_fees"].get(age_group, 300)
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
    
    # 4. Extension (20:00-21:00) — 年齢別料金
    ext_count = sum(1 for f in facts if f.get("is_extension") and not f.get("is_night"))
    if ext_count > 0:
        fee = pricing["extension_fees"].get(age_group, 300)
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
    
    # 5. Night (21:00+) — 月極/一時で金額が異なる
    night_count = sum(1 for f in facts if f.get("is_night"))
    if night_count > 0:
        fee = pricing["night_fee_temp"] if enrollment == "一時" else pricing["night_fee_monthly"]
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
    # ★ 朝食（breakfast）追加: ¥150/食（保育料案内準拠）
    meal_types = [
        ("breakfast", "has_breakfast", "朝食"),
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
