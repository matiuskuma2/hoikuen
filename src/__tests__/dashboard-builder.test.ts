/**
 * buildDashboardFromFormData ユニットテスト
 * 
 * FormDataベースのダッシュボード構築をテスト:
 * - 予定表のみモード (schedule-only)
 * - ルクミー + 予定表の統合モード
 * - 閾値の一貫性検証
 * - ファイルサイズ制限チェック
 * - 警告伝播
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildDashboardFromFormData, type DashboardResult } from '../lib/dashboard-builder';
import { TIME_BOUNDARIES } from '../types/index';

// ── ヘルパー関数 ──

const LUKUMI_HEADER = [
  'クラス名', '園児姓', '園児名', '日付', '登園日時', '降園日時', 'メモ',
  '園児ID', '姓よみ', '名よみ', '生年月日', 'クラス年齢',
];

function makeLukumiBuffer(rows: (string | number | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

function makeScheduleBuffer(opts: {
  year: number; month: number; childName: string;
  days: { day: number; start: string; end: string; lunch?: boolean; pmSnack?: boolean; dinner?: boolean }[];
}): ArrayBuffer {
  const ws: XLSX.WorkSheet = {};
  ws['!ref'] = 'A1:Q28';
  const set = (r: number, c: number, v: any) => {
    ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })] = { v, t: typeof v === 'number' ? 'n' : 's' };
  };
  set(1, 6, opts.year);
  set(1, 10, opts.month);
  set(6, 4, opts.childName);
  set(11, 6, '昼食');
  set(11, 7, 'おやつ(AM)');

  for (const d of opts.days) {
    const isLeft = d.day <= 15;
    const row = 12 + (isLeft ? d.day - 1 : d.day - 16);
    set(row, isLeft ? 2 : 10, d.day);
    set(row, isLeft ? 4 : 12, d.start);
    set(row, isLeft ? 5 : 13, d.end);
    if (d.lunch) set(row, isLeft ? 6 : 14, '〇');
    if (d.pmSnack) set(row, isLeft ? 8 : 16, '〇');
    if (d.dinner) set(row, isLeft ? 9 : 17, '〇');
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '原本');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/** FormData を構築 (Cloudflare Workers 互換: File ≈ Blob + name) */
function buildFormData(opts: {
  lukumi?: ArrayBuffer;
  lukumiName?: string;
  schedules?: Array<{ data: ArrayBuffer; name: string }>;
}): FormData {
  const fd = new FormData();
  if (opts.lukumi) {
    const blob = new Blob([opts.lukumi], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fd.append('lukumi_file', new File([blob], opts.lukumiName || 'lukumi.xlsx'));
  }
  if (opts.schedules) {
    for (const s of opts.schedules) {
      const blob = new Blob([s.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      fd.append('schedule_files', new File([blob], s.name));
    }
  }
  return fd;
}

describe('buildDashboardFromFormData — 予定表のみモード', () => {
  it('ルクミーなし＋予定表1件 → schedule-only モード', async () => {
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [
        { day: 1, start: '08:30', end: '17:00', lunch: true },
        { day: 2, start: '09:00', end: '16:00' },
      ],
    });
    const fd = buildFormData({ schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }] });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    expect(result.is_schedule_only).toBe(true);
    expect(result.total_children).toBe(1);
    expect(result.days_in_month).toBe(31);
    expect(result.daily_summary).toHaveLength(31);
    expect(result.children_summary).toHaveLength(1);
    expect(result.children_summary[0]).toMatchObject({ name: '田中 太郎' });
    // info-level warning about schedule-only mode
    expect(result.warnings.some(w => w.level === 'info' && w.message.includes('予定プレビューモード'))).toBe(true);
  });

  it('予定表もルクミーもなし → children 0件', async () => {
    const fd = buildFormData({});
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    expect(result.total_children).toBe(0);
    expect(result.is_schedule_only).toBe(true);
    expect(result.daily_summary).toHaveLength(31);
  });
});

describe('buildDashboardFromFormData — ルクミー + 予定表統合', () => {
  it('突合成功 → is_schedule_only=false, 出席と予定が統合', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '08:25', '17:05', '', 'LK001', 'タナカ', 'タロウ', '2022/04/15', '3'],
    ]);
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 1, start: '08:30', end: '17:00', lunch: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      lukumiName: 'lukumi_2026_03.xlsx',
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    expect(result.is_schedule_only).toBe(false);
    expect(result.total_children).toBe(1);

    // Day 1 should have present child
    const day1 = result.daily_summary[0] as any;
    expect(day1.day).toBe(1);
    expect(day1.total_children).toBeGreaterThanOrEqual(1);

    // Children summary should show attendance
    const cs = result.children_summary[0] as any;
    expect(cs.attendance_days).toBeGreaterThanOrEqual(1);
    expect(cs.has_schedule).toBe(true);
  });
});

describe('buildDashboardFromFormData — 閾値の一貫性', () => {
  it('18:01降園 → extension_count > 0 を daily_summary で確認', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/05', '08:30', '18:01', '', 'LK001', '', '', '', '3'],
    ]);
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 5, start: '08:30', end: '18:01', lunch: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    const day5 = result.daily_summary[4] as any; // 0-indexed, day=5 → index 4
    expect(day5.day).toBe(5);
    expect(day5.extension_count).toBeGreaterThanOrEqual(1);
    expect(day5.night_count).toBe(0);
  });

  it('20:01降園 → extension_count + night_count 両方', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/10', '08:30', '20:01', '', 'LK001', '', '', '', '3'],
    ]);
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 10, start: '08:30', end: '20:01', lunch: true, dinner: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    const day10 = result.daily_summary[9] as any;
    expect(day10.day).toBe(10);
    expect(day10.extension_count).toBeGreaterThanOrEqual(1);
    expect(day10.night_count).toBeGreaterThanOrEqual(1);
  });

  it('07:00登園 → early_morning_count > 0', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/03', '07:00', '17:00', '', 'LK001', '', '', '', '3'],
    ]);
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 3, start: '07:00', end: '17:00', lunch: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    const day3 = result.daily_summary[2] as any;
    expect(day3.day).toBe(3);
    expect(day3.early_morning_count).toBeGreaterThanOrEqual(1);
  });

  it('TIME_BOUNDARIES 境界値: 18:00ちょうど → 延長なし（> 判定）', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/07', '08:30', '18:00', '', 'LK001', '', '', '', '3'],
    ]);
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 7, start: '08:30', end: '18:00', lunch: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    const day7 = result.daily_summary[6] as any;
    expect(day7.extension_count).toBe(0);
    expect(day7.night_count).toBe(0);
  });
});

describe('buildDashboardFromFormData — 提出レポート', () => {
  it('予定提出済み/未提出を正しく分類', async () => {
    const lukumiBuf = makeLukumiBuffer([
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '08:30', '17:00', '', 'LK001', '', '', '', '3'],
      ['2歳児', '鈴木', '花子', '2026/03/01', '09:00', '16:00', '', 'LK002', '', '', '', '2'],
    ]);
    // Only submit schedule for 田中
    const schedBuf = makeScheduleBuffer({
      year: 2026, month: 3, childName: '田中 太郎',
      days: [{ day: 1, start: '08:30', end: '17:00', lunch: true }],
    });
    const fd = buildFormData({
      lukumi: lukumiBuf,
      schedules: [{ data: schedBuf, name: 'tanaka.xlsx' }],
    });
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });

    const report = result.submission_report as any;
    expect(report.summary.submitted).toBe(1); // 田中
    expect(report.summary.not_submitted).toBe(1); // 鈴木
    expect(report.submitted[0].name).toBe('田中 太郎');
    expect(report.not_submitted[0].name).toBe('鈴木 花子');
  });
});

describe('buildDashboardFromFormData — 日数', () => {
  it('3月 = 31日', async () => {
    const fd = buildFormData({});
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 3 });
    expect(result.days_in_month).toBe(31);
    expect(result.daily_summary).toHaveLength(31);
  });

  it('2月 (閏年なし) = 28日', async () => {
    const fd = buildFormData({});
    const result = await buildDashboardFromFormData({ formData: fd, year: 2026, month: 2 });
    expect(result.days_in_month).toBe(28);
    expect(result.daily_summary).toHaveLength(28);
  });

  it('2月 (閏年) = 29日', async () => {
    const fd = buildFormData({});
    const result = await buildDashboardFromFormData({ formData: fd, year: 2028, month: 2 });
    expect(result.days_in_month).toBe(29);
    expect(result.daily_summary).toHaveLength(29);
  });
});
