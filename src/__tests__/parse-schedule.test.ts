/**
 * parseSchedule ユニットテスト
 * 
 * 利用予定表Excelパースロジックをテスト
 * - 新フォーマット（食事列分離）
 * - レイアウト自動検出
 * - 日付/時刻/フラグ読み取り
 * - 園児名抽出
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseSchedule } from '../lib/excel-parser';

/**
 * 新フォーマットの予定表Excelを生成するヘルパー
 * 実際のレイアウト:
 *   Row 1: ... F1=年, J1=月
 *   Row 6: ... D6=園児名
 *   Row 11: ヘッダー行(昼食/おやつ等)
 *   Row 12-26: 左半分(1-15日)
 *   Row 12-27: 右半分(16-31日)
 */
function makeScheduleExcel(opts: {
  year: number;
  month: number;
  childName: string;
  days: Array<{
    day: number;
    start: string;
    end: string;
    lunch?: boolean;
    amSnack?: boolean;
    pmSnack?: boolean;
    dinner?: boolean;
  }>;
}): ArrayBuffer {
  const ws: XLSX.WorkSheet = {};
  ws['!ref'] = 'A1:Q28';

  // Helper to set cell
  const set = (r: number, c: number, v: any) => {
    const addr = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
    ws[addr] = { v, t: typeof v === 'number' ? 'n' : 's' };
  };

  // Year/month for new format: F1=year, J1=month
  set(1, 6, opts.year);
  set(1, 10, opts.month);

  // Child name at D6
  set(6, 4, opts.childName);

  // Header row 11: F11=昼食, G11=おやつ (triggers new format detection)
  set(11, 6, '昼食');
  set(11, 7, 'おやつ(AM)');
  set(11, 8, 'おやつ(PM)');
  set(11, 9, '夕食');

  // New format columns:
  // Left: B=日, D=開始, E=終了, F=昼食, G=AM, H=PM, I=夕食
  // Right: J=日, L=開始, M=終了, N=昼食, O=AM, P=PM, Q=夕食
  for (const d of opts.days) {
    const isLeft = d.day <= 15;
    const row = 12 + (isLeft ? d.day - 1 : d.day - 16);
    const dateCol = isLeft ? 2 : 10;
    const startCol = isLeft ? 4 : 12;
    const endCol = isLeft ? 5 : 13;
    const lunchCol = isLeft ? 6 : 14;
    const amCol = isLeft ? 7 : 15;
    const pmCol = isLeft ? 8 : 16;
    const dinnerCol = isLeft ? 9 : 17;

    set(row, dateCol, d.day);
    set(row, startCol, d.start);
    set(row, endCol, d.end);
    if (d.lunch) set(row, lunchCol, '〇');
    if (d.amSnack) set(row, amCol, '〇');
    if (d.pmSnack) set(row, pmCol, '〇');
    if (d.dinner) set(row, dinnerCol, '〇');
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '原本');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

describe('parseSchedule — 新フォーマット', () => {
  it('基本的な1日分のパース', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: '田中 太郎',
      days: [
        { day: 1, start: '08:30', end: '17:00', lunch: true, pmSnack: true },
      ],
    });
    const result = parseSchedule(buf, 'schedule_tanaka.xlsx', 2026, 3);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].childName).toBe('田中 太郎');
    expect(result.results[0].plans[1]).toBeDefined();
    expect(result.results[0].plans[1].planned_start).toBe('08:30');
    expect(result.results[0].plans[1].planned_end).toBe('17:00');
    expect(result.results[0].plans[1].lunch_flag).toBe(1);
    expect(result.results[0].plans[1].pm_snack_flag).toBe(1);
    expect(result.results[0].plans[1].dinner_flag).toBe(0);
  });

  it('右半分（16日以降）のパース', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: '鈴木 花子',
      days: [
        { day: 20, start: '09:00', end: '18:30', lunch: true, amSnack: true, pmSnack: true, dinner: true },
      ],
    });
    const result = parseSchedule(buf, 'schedule_suzuki.xlsx', 2026, 3);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].plans[20]).toBeDefined();
    expect(result.results[0].plans[20].planned_start).toBe('09:00');
    expect(result.results[0].plans[20].planned_end).toBe('18:30');
    expect(result.results[0].plans[20].am_snack_flag).toBe(1);
    expect(result.results[0].plans[20].dinner_flag).toBe(1);
  });

  it('複数日のデータをまとめてパース', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: '山田 一郎',
      days: [
        { day: 1, start: '07:00', end: '20:01', lunch: true },
        { day: 2, start: '08:30', end: '17:00', lunch: true },
        { day: 15, start: '09:00', end: '16:00' },
        { day: 16, start: '08:00', end: '19:00', lunch: true, pmSnack: true },
        { day: 31, start: '10:00', end: '15:00' },
      ],
    });
    const result = parseSchedule(buf, 'schedule.xlsx', 2026, 3);

    expect(result.results).toHaveLength(1);
    const plans = result.results[0].plans;
    expect(Object.keys(plans)).toHaveLength(5);
    expect(plans[1].planned_start).toBe('07:00');
    expect(plans[1].planned_end).toBe('20:01');
    expect(plans[31].planned_start).toBe('10:00');
  });

  it('食事フラグが正しくセットされる（全ビット）', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: 'テスト 園児',
      days: [
        { day: 5, start: '07:00', end: '21:00', lunch: true, amSnack: true, pmSnack: true, dinner: true },
      ],
    });
    const result = parseSchedule(buf, 'test.xlsx', 2026, 3);
    const plan = result.results[0].plans[5];
    
    expect(plan.lunch_flag).toBe(1);
    expect(plan.am_snack_flag).toBe(1);
    expect(plan.pm_snack_flag).toBe(1);
    expect(plan.dinner_flag).toBe(1);
  });

  it('食事フラグなし → 全て 0', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: 'テスト 園児',
      days: [
        { day: 5, start: '08:00', end: '17:00' },
      ],
    });
    const result = parseSchedule(buf, 'test.xlsx', 2026, 3);
    const plan = result.results[0].plans[5];
    
    expect(plan.lunch_flag).toBe(0);
    expect(plan.am_snack_flag).toBe(0);
    expect(plan.pm_snack_flag).toBe(0);
    expect(plan.dinner_flag).toBe(0);
  });
});

describe('parseSchedule — エラーハンドリング', () => {
  it('空バッファ → results空', () => {
    const result = parseSchedule(new ArrayBuffer(0), 'empty.xlsx', 2026, 3);
    // XLSX.read は空バッファでもエラーにならない (空のワークブックが返る)
    // しかし有効な園児名やデータが見つからないので results は空になる
    expect(result.results).toHaveLength(0);
  });

  it('園児名が見つからないシート → results空', () => {
    // 全セルが空のExcelを作成
    const ws: XLSX.WorkSheet = { '!ref': 'A1:A1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

    const result = parseSchedule(buf, 'no-name.xlsx', 2026, 3);
    expect(result.results).toHaveLength(0);
  });
});

describe('parseSchedule — 園児名正規化', () => {
  it('全角スペースが正規化される', () => {
    const buf = makeScheduleExcel({
      year: 2026, month: 3,
      childName: '田中\u3000太郎', // 全角スペース
      days: [{ day: 1, start: '08:00', end: '17:00' }],
    });
    const result = parseSchedule(buf, 'test.xlsx', 2026, 3);
    expect(result.results[0].childName).toBe('田中 太郎'); // 半角スペースに変換
  });
});
