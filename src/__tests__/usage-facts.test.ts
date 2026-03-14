/**
 * computeUsageFacts 閾値テスト
 * 
 * excel-parser.ts の computeUsageFacts → computeSingleFact が
 * TIME_BOUNDARIES を正しく使っているかを確認
 */
import { describe, it, expect } from 'vitest';
import { computeUsageFacts, type MatchedChild, type SchedulePlan, type AttendanceRecord } from '../lib/excel-parser';

function makeChild(overrides: Partial<MatchedChild> = {}): MatchedChild {
  return {
    id: 'test_001',
    lukumi_id: 'test_001',
    name: 'テスト 太郎',
    name_norm: 'テスト 太郎',
    name_kana: null,
    age_class: 3,
    enrollment_type: '月極',
    birth_date: '2022-04-15',
    class_name: '3歳児',
    has_schedule: true,
    schedule_file: 'test.xlsx',
    is_allergy: 0,
    child_order: 1,
    ...overrides,
  };
}

function makePlan(day: number, start: string, end: string): SchedulePlan {
  return {
    day,
    planned_start: start,
    planned_end: end,
    lunch_flag: 1,
    am_snack_flag: 0,
    pm_snack_flag: 1,
    dinner_flag: 0,
    breakfast_flag: 0,
    child_name: 'テスト 太郎',
    source_file: 'test.xlsx',
  };
}

function makeAttendance(day: number, checkin: string, checkout: string): AttendanceRecord {
  return {
    lukumi_id: 'test_001',
    name: 'テスト 太郎',
    year: 2026,
    month: 3,
    day,
    actual_checkin: checkin,
    actual_checkout: checkout,
    memo: null,
    class_name: '3歳児',
  };
}

describe('computeUsageFacts — 延長/夜間閾値', () => {
  const child = makeChild();
  const children = [child];

  it('17:59降園 → 延長なし・夜間なし', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '17:59') }]]);
    const attendance = [makeAttendance(1, '08:25', '17:59')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(0);
    expect(day1?.is_night).toBe(0);
  });

  it('18:00降園 → 延長なし（> 判定のため）', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '18:00') }]]);
    const attendance = [makeAttendance(1, '08:25', '18:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(0);
    expect(day1?.is_night).toBe(0);
  });

  it('18:01降園 → 延長あり・夜間なし', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '18:01') }]]);
    const attendance = [makeAttendance(1, '08:25', '18:01')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(1);
    expect(day1?.is_night).toBe(0);
  });

  it('19:59降園 → 延長あり・夜間なし', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '19:59') }]]);
    const attendance = [makeAttendance(1, '08:25', '19:59')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(1);
    expect(day1?.is_night).toBe(0);
  });

  it('20:00降園 → 延長あり・夜間なし（> 判定のため）', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '20:00') }]]);
    const attendance = [makeAttendance(1, '08:25', '20:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(1);
    expect(day1?.is_night).toBe(0);
  });

  it('20:01降園 → 延長あり・夜間あり', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '20:01') }]]);
    const attendance = [makeAttendance(1, '08:25', '20:01')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(1);
    expect(day1?.is_night).toBe(1);
  });

  it('21:00降園 → 延長あり・夜間あり', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '21:00') }]]);
    const attendance = [makeAttendance(1, '08:25', '21:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_extension).toBe(1);
    expect(day1?.is_night).toBe(1);
  });
});

describe('computeUsageFacts — 早朝保育閾値', () => {
  const child = makeChild();
  const children = [child];

  it('07:00登園 → 早朝あり', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '07:00', '17:00') }]]);
    const attendance = [makeAttendance(1, '07:00', '17:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_early_morning).toBe(1);
  });

  it('07:29登園 → 早朝あり', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '07:29', '17:00') }]]);
    const attendance = [makeAttendance(1, '07:29', '17:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_early_morning).toBe(1);
  });

  it('07:30登園 → 早朝なし', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '07:30', '17:00') }]]);
    const attendance = [makeAttendance(1, '07:30', '17:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_early_morning).toBe(0);
  });

  it('08:30登園 → 早朝なし', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '17:00') }]]);
    const attendance = [makeAttendance(1, '08:30', '17:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.is_early_morning).toBe(0);
  });
});

describe('computeUsageFacts — 出欠ステータス', () => {
  const child = makeChild();
  const children = [child];

  it('予定あり・実績あり → present', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '17:00') }]]);
    const attendance = [makeAttendance(1, '08:30', '17:00')];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.attendance_status).toBe('present');
  });

  it('予定あり・実績なし → absent', () => {
    const plans = new Map([['テスト 太郎', { 1: makePlan(1, '08:30', '17:00') }]]);
    const attendance: AttendanceRecord[] = [];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.attendance_status).toBe('absent');
  });

  it('予定なし・実績なし → absent_no_plan', () => {
    const plans = new Map<string, Record<number, SchedulePlan>>();
    const attendance: AttendanceRecord[] = [];
    const facts = computeUsageFacts(children, plans, attendance, 2026, 3);
    const day1 = facts.find(f => f.day === 1 && f.child_name === 'テスト 太郎');
    expect(day1?.attendance_status).toBe('absent_no_plan');
  });
});
