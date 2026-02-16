/**
 * Charge Lines Generation Engine
 * 
 * Aggregates monthly usage_facts into charge_lines per child
 */

import {
  type Child,
  type UsageFact,
  type ChargeLine,
  type PricingRules,
  getAgeGroup
} from '../types/index';

export function generateChargeLines(
  child: Child,
  facts: UsageFact[],
  rules: PricingRules,
  year: number,
  month: number
): ChargeLine[] {

  const lines: ChargeLine[] = [];
  const ageGroup = getAgeGroup(child.age_class ?? 0);

  // 1. Monthly fee (月極 only)
  if (child.enrollment_type === '月極') {
    const monthlyFees = rules.monthly_fees[ageGroup];
    const monthly = monthlyFees ? (monthlyFees[String(child.child_order)] ?? 0) : 0;
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'monthly_fee',
      quantity: 1,
      unit_price: monthly,
      subtotal: monthly,
      notes: `${ageGroup} 第${child.child_order}子`,
    });
  }

  // 2. Spot care (一時 only)
  if (child.enrollment_type === '一時') {
    const totalBlocks = facts.reduce((sum, f) => sum + f.spot_30min_blocks, 0);
    const unit = rules.spot_rates[ageGroup] ?? 200;
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'spot_care',
      quantity: totalBlocks,
      unit_price: unit,
      subtotal: totalBlocks * unit,
      notes: `30分×${totalBlocks}回`,
    });
  }

  // 3. Early morning
  const earlyCount = facts.filter(f => f.is_early_morning === 1).length;
  if (earlyCount > 0) {
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'early_morning',
      quantity: earlyCount,
      unit_price: rules.early_morning_fee,
      subtotal: earlyCount * rules.early_morning_fee,
      notes: null,
    });
  }

  // 4. Extension (18:00-20:00, excluding night)
  const extCount = facts.filter(f => f.is_extension === 1 && f.is_night === 0).length;
  if (extCount > 0) {
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'extension',
      quantity: extCount,
      unit_price: rules.extension_fee,
      subtotal: extCount * rules.extension_fee,
      notes: null,
    });
  }

  // 5. Night (20:00+)
  const nightCount = facts.filter(f => f.is_night === 1).length;
  if (nightCount > 0) {
    const nightUnit = rules.night_fees[ageGroup] ?? 2500;
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'night',
      quantity: nightCount,
      unit_price: nightUnit,
      subtotal: nightCount * nightUnit,
      notes: null,
    });
  }

  // 6. Sick care
  const sickCount = facts.filter(f => f.is_sick === 1).length;
  if (sickCount > 0) {
    lines.push({
      id: '',
      child_id: child.id,
      year,
      month,
      charge_type: 'sick',
      quantity: sickCount,
      unit_price: rules.sick_fee,
      subtotal: sickCount * rules.sick_fee,
      notes: null,
    });
  }

  // 7. Meals
  const mealTypes = [
    { type: 'lunch', flag: 'has_lunch' as const, price: rules.meal_prices.lunch },
    { type: 'am_snack', flag: 'has_am_snack' as const, price: rules.meal_prices.am_snack },
    { type: 'pm_snack', flag: 'has_pm_snack' as const, price: rules.meal_prices.pm_snack },
    { type: 'dinner', flag: 'has_dinner' as const, price: rules.meal_prices.dinner },
  ];

  for (const meal of mealTypes) {
    const count = facts.filter(f => f[meal.flag] === 1).length;
    if (count > 0) {
      lines.push({
        id: '',
        child_id: child.id,
        year,
        month,
        charge_type: meal.type,
        quantity: count,
        unit_price: meal.price,
        subtotal: count * meal.price,
        notes: null,
      });
    }
  }

  return lines;
}
