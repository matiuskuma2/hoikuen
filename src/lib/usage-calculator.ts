/**
 * Usage Facts Calculation Engine
 * 
 * Core billing logic: v3.1 (2026-02-16)
 * - billing_start = planned_start (if exists) else actual_checkin
 * - billing_end   = max(planned_end, actual_checkout)
 */

import {
  type SchedulePlan,
  type AttendanceRecord,
  type Child,
  type UsageFact,
  type PricingRules,
  toMinutes,
  formatTimeNoLeadingZero
} from '../types/index';

export function computeUsageFact(
  child: Child,
  plan: SchedulePlan | null,
  actual: AttendanceRecord | null,
  rules: PricingRules,
  year: number,
  month: number,
  day: number
): UsageFact {

  const fact: UsageFact = {
    id: '',
    child_id: child.id,
    year,
    month,
    day,
    billing_start: null,
    billing_end: null,
    billing_minutes: null,
    is_early_morning: 0,
    is_extension: 0,
    is_night: 0,
    is_sick: 0,
    spot_30min_blocks: 0,
    has_lunch: 0,
    has_am_snack: 0,
    has_pm_snack: 0,
    has_dinner: 0,
    meal_allergy: child.is_allergy,
    attendance_status: 'absent_no_plan',
    exception_notes: null,
  };

  // --- Step 1: Presence check ---
  const hasPlan = plan !== null && plan.planned_start !== null;
  const hasCheckin = actual !== null && actual.actual_checkin !== null;
  const hasCheckout = actual !== null && actual.actual_checkout !== null;

  if (!hasPlan && !hasCheckin) {
    fact.attendance_status = 'absent_no_plan';
    return fact;
  }

  if (hasPlan && !hasCheckin) {
    fact.attendance_status = 'absent';
    fact.exception_notes = '予定あり・実績なし（欠席）';
    return fact;
  }

  // --- Step 2: Billing time determination ---
  // ★★★ Core rule v3.1 ★★★
  //   start = planned_start (if plan exists), else actual_checkin
  //   end   = max(planned_end, actual_checkout)
  let billingStartStr: string;
  let billingEndStr: string | null = null;
  const notes: string[] = [];

  if (hasPlan && hasCheckin) {
    // Start: ALWAYS use planned_start (charge from scheduled time even if late)
    billingStartStr = plan!.planned_start!;

    // End: max(planned_end, actual_checkout)
    if (hasCheckout && plan!.planned_end) {
      const planEndMin = toMinutes(plan!.planned_end);
      const actualEndMin = toMinutes(actual!.actual_checkout!);
      billingEndStr = actualEndMin > planEndMin
        ? actual!.actual_checkout!
        : plan!.planned_end;
    } else if (hasCheckout) {
      billingEndStr = actual!.actual_checkout!;
    } else if (plan!.planned_end) {
      billingEndStr = plan!.planned_end;
    }

    fact.attendance_status = 'present';

    // Early leave detection: actual checkout > 30min before planned end
    if (hasCheckout && plan!.planned_end) {
      const diff = toMinutes(plan!.planned_end) - toMinutes(actual!.actual_checkout!);
      if (diff > 30) {
        fact.attendance_status = 'early_leave';
      }
    }

    // Late arrival detection: actual checkin > 15min after planned start
    if (plan!.planned_start) {
      const diff = toMinutes(actual!.actual_checkin!) - toMinutes(plan!.planned_start);
      if (diff > 15) {
        fact.attendance_status = 'late_arrive';
      }
    }

  } else if (!hasPlan && hasCheckin) {
    // Walk-in: no plan, use actual times
    billingStartStr = actual!.actual_checkin!;
    billingEndStr = hasCheckout ? actual!.actual_checkout! : null;
    notes.push('予定表未提出・実績のみ');
    fact.attendance_status = 'present';
  } else {
    // Should not reach here
    return fact;
  }

  if (!billingEndStr) {
    notes.push('降園未記録');
  }

  fact.billing_start = formatTimeNoLeadingZero(billingStartStr);
  fact.billing_end = billingEndStr ? formatTimeNoLeadingZero(billingEndStr) : null;

  // --- Step 3: Billing minutes ---
  if (fact.billing_start && fact.billing_end) {
    const mins = toMinutes(fact.billing_end) - toMinutes(fact.billing_start);
    if (mins < 0) {
      fact.billing_minutes = 0;
      notes.push('負の利用時間（エラー）');
    } else {
      fact.billing_minutes = mins;
    }
  }

  // --- Step 4: Time zone flags ---
  const startMin = toMinutes(fact.billing_start!);
  const endMin = fact.billing_end ? toMinutes(fact.billing_end) : null;

  const earlyStart = toMinutes(rules.time_boundaries.early_start); // 420
  const earlyEnd = toMinutes(rules.time_boundaries.early_end);     // 450
  const extStart = toMinutes(rules.time_boundaries.extension_start); // 1080
  const nightStart = toMinutes(rules.time_boundaries.night_start);   // 1200

  // Early morning: 7:00-7:30
  fact.is_early_morning = (startMin < earlyEnd && startMin >= earlyStart) ? 1 : 0;

  // Extension: after 18:00
  fact.is_extension = (endMin !== null && endMin > extStart) ? 1 : 0;

  // Night: after 20:00
  fact.is_night = (endMin !== null && endMin > nightStart) ? 1 : 0;

  // --- Step 5: Spot care blocks ---
  if (child.enrollment_type === '一時' && fact.billing_minutes !== null) {
    fact.spot_30min_blocks = Math.ceil(fact.billing_minutes / 30);
  }

  // --- Step 6: Meal flags ---
  if (fact.attendance_status === 'present' || fact.attendance_status === 'late_arrive') {
    if (hasPlan) {
      fact.has_lunch = plan!.lunch_flag;
      fact.has_am_snack = plan!.am_snack_flag;
      fact.has_pm_snack = plan!.pm_snack_flag;
      fact.has_dinner = plan!.dinner_flag;
    } else {
      // Infer from presence hours
      fact.has_lunch = (startMin <= 720 && (endMin ?? 0) >= 720) ? 1 : 0;
      fact.has_am_snack = (startMin <= 600) ? 1 : 0;
      fact.has_pm_snack = ((endMin ?? 0) >= 900) ? 1 : 0;
      fact.has_dinner = ((endMin ?? 0) >= 1080) ? 1 : 0;
    }

    // Adjust meals for early leave
    if (fact.attendance_status === 'early_leave' && endMin !== null) {
      if (endMin < 720) fact.has_lunch = 0;
      if (endMin < 900) fact.has_pm_snack = 0;
      if (endMin < 1080) fact.has_dinner = 0;
    }
  }

  if (notes.length > 0) {
    fact.exception_notes = notes.join(' / ');
  }

  return fact;
}
