/**
 * parseLukumi ユニットテスト
 * 
 * ルクミー登降園CSVのパースロジックをテスト
 * - ヘッダー自動検出
 * - 日付/時刻パース
 * - 園児情報抽出
 * - 空データ/不正データ対応
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseLukumi } from '../lib/excel-parser';

/** テスト用Excelバイナリ生成 */
function makeExcelBuffer(rows: (string | number | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return buf;
}

// 標準的なルクミーヘッダー
const LUKUMI_HEADER = [
  'クラス名', '園児姓', '園児名', '日付', '登園日時', '降園日時', 'メモ',
  '園児ID', '姓よみ', '名よみ', '生年月日', 'クラス年齢',
];

describe('parseLukumi — 正常データ', () => {
  it('1行のレコードを正しくパース', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '08:30', '17:00', '', 'LK001', 'タナカ', 'タロウ', '2022/04/15', '3'],
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0].lukumi_id).toBe('LK001');
    expect(result.attendance[0].name).toBe('田中 太郎');
    expect(result.attendance[0].year).toBe(2026);
    expect(result.attendance[0].month).toBe(3);
    expect(result.attendance[0].day).toBe(1);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].lukumi_id).toBe('LK001');
    expect(result.children[0].name_kana).toBe('タナカ タロウ');
  });

  it('複数園児・複数日を正しく分離', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '08:30', '17:00', '', 'LK001', 'タナカ', 'タロウ', '2022/04/15', '3'],
      ['3歳児', '田中', '太郎', '2026/03/02', '08:25', '17:30', '', 'LK001', 'タナカ', 'タロウ', '2022/04/15', '3'],
      ['2歳児', '鈴木', '花子', '2026/03/01', '09:00', '16:00', '', 'LK002', 'スズキ', 'ハナコ', '2023/07/10', '2'],
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(3);
    expect(result.children).toHaveLength(2); // unique by lukumi_id
  });

  it('対象月と異なる日付はフィルタされる', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/15', '08:30', '17:00', '', 'LK001', '', '', '', '3'],
      ['3歳児', '田中', '太郎', '2026/02/28', '08:30', '17:00', '', 'LK001', '', '', '', '3'], // wrong month
      ['3歳児', '田中', '太郎', '2025/03/01', '08:30', '17:00', '', 'LK001', '', '', '', '3'], // wrong year
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0].day).toBe(15);
  });
});

describe('parseLukumi — エラーハンドリング', () => {
  it('空の ArrayBuffer → エラー警告', () => {
    const result = parseLukumi(new ArrayBuffer(0), 'empty.xlsx', 2026, 3);
    expect(result.attendance).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.level === 'error')).toBe(true);
  });

  it('ヘッダーのみ（データ行なし）→ エラー警告', () => {
    const rows = [LUKUMI_HEADER];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'header-only.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(0);
    // 1行しかないため「データ行がありません」エラーになる
    expect(result.warnings.some(w => w.level === 'error')).toBe(true);
  });

  it('園児ID欠落行はスキップ', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '08:30', '17:00', '', '', '', '', '', '3'], // empty lukumi_id
      ['3歳児', '鈴木', '花子', '2026/03/01', '09:00', '16:00', '', 'LK002', '', '', '', '2'],
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0].lukumi_id).toBe('LK002');
  });

  it('日付欠落行はスキップ', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '', '08:30', '17:00', '', 'LK001', '', '', '', '3'], // empty date
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(0);
  });
});

describe('parseLukumi — 時刻パース', () => {
  it('HH:MM 形式の時刻文字列を正しくパース', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '7:00', '20:01', '', 'LK001', '', '', '', '3'],
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(1);
    // parseTimeValue normalizes to HH:MM
    expect(result.attendance[0].actual_checkin).toMatch(/^0?7:00$/);
    expect(result.attendance[0].actual_checkout).toMatch(/^20:01$/);
  });

  it('登園/降園なし（null）も許容', () => {
    const rows = [
      LUKUMI_HEADER,
      ['3歳児', '田中', '太郎', '2026/03/01', '', '', '', 'LK001', '', '', '', '3'],
    ];
    const buf = makeExcelBuffer(rows);
    const result = parseLukumi(buf, 'test.xlsx', 2026, 3);

    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0].actual_checkin).toBeNull();
    expect(result.attendance[0].actual_checkout).toBeNull();
  });
});
