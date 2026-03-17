/**
 * Billing Excel Generator (請求明細 Excel)
 * 
 * Phase A-1: SheetJS でスクラッチからExcelを生成
 * DB テーブル (children, charge_lines, usage_facts) からデータを取得し、
 * 園児ごとの請求明細を値のみ（数式なし）で出力する。
 * 
 * Created: 2026-03-17
 */

import * as XLSX from 'xlsx';
import {
  type Child,
  type ChargeLine,
  type PricingRules,
  getAgeGroup,
} from '../types/index';
import { ageClassToLabel } from './age-class';

/** 請求明細の園児行データ */
interface BillingRow {
  child: Child;
  chargeLines: ChargeLine[];
}

/** charge_type → 日本語ヘッダ */
const CHARGE_TYPE_LABELS: Record<string, string> = {
  monthly_fee: '月額保育料',
  spot_care: '一時保育料',
  early_morning: '早朝保育料',
  extension: '延長保育料',
  night: '夜間保育料',
  sick: '病児保育料',
  breakfast: '朝食',
  lunch: '昼食',
  am_snack: 'AM間食',
  pm_snack: 'PM間食',
  dinner: '夕食',
};

/** 請求明細のカラム順序 */
const CHARGE_COLUMNS = [
  'monthly_fee', 'spot_care', 'early_morning', 'extension',
  'night', 'sick', 'breakfast', 'lunch', 'am_snack', 'pm_snack', 'dinner',
] as const;

/**
 * 請求明細Excelを生成
 * @param rows 園児ごとのchargeLineデータ
 * @param year 対象年
 * @param month 対象月
 * @param rules PricingRules（単価表示用）
 * @returns ExcelバイナリのArrayBuffer
 */
export function generateBillingExcel(
  rows: BillingRow[],
  year: number,
  month: number,
  rules: PricingRules | null,
): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════
  // Sheet 1: 請求一覧（サマリー）
  // ═══════════════════════════════════
  const summaryData: (string | number | null)[][] = [];

  // Title row
  summaryData.push([`${year}年${month}月 請求明細一覧`, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]);

  // Empty row
  summaryData.push([]);

  // Header row
  summaryData.push([
    'No', 'クラス', '氏名', '生年月日', '区分',
    '月額保育料', '一時保育料', '早朝保育料', '延長保育料',
    '夜間保育料', '病児保育料',
    '朝食', '昼食', 'AM間食', 'PM間食', '夕食',
    '食事小計', '合計金額',
  ]);

  let grandTotal = 0;

  // Data rows (sorted by enrollment_type desc then age_class asc then name)
  const sortedRows = [...rows].sort((a, b) => {
    // 月極 first, then 一時
    if (a.child.enrollment_type !== b.child.enrollment_type) {
      return a.child.enrollment_type === '月極' ? -1 : 1;
    }
    // Then by age_class
    const ageA = a.child.age_class ?? 99;
    const ageB = b.child.age_class ?? 99;
    if (ageA !== ageB) return ageA - ageB;
    // Then by name
    return a.child.name.localeCompare(b.child.name, 'ja');
  });

  sortedRows.forEach((row, idx) => {
    const c = row.child;
    const cls = ageClassToLabel(c.age_class, c.enrollment_type);
    const birthStr = c.birth_date || '';

    // Build charge map
    const chargeMap = new Map<string, number>();
    for (const cl of row.chargeLines) {
      chargeMap.set(cl.charge_type, (chargeMap.get(cl.charge_type) || 0) + cl.subtotal);
    }

    const monthlyFee = chargeMap.get('monthly_fee') || 0;
    const spotCare = chargeMap.get('spot_care') || 0;
    const earlyMorning = chargeMap.get('early_morning') || 0;
    const extension = chargeMap.get('extension') || 0;
    const night = chargeMap.get('night') || 0;
    const sick = chargeMap.get('sick') || 0;
    const breakfast = chargeMap.get('breakfast') || 0;
    const lunch = chargeMap.get('lunch') || 0;
    const amSnack = chargeMap.get('am_snack') || 0;
    const pmSnack = chargeMap.get('pm_snack') || 0;
    const dinner = chargeMap.get('dinner') || 0;

    const mealSubtotal = breakfast + lunch + amSnack + pmSnack + dinner;
    const total = monthlyFee + spotCare + earlyMorning + extension + night + sick + mealSubtotal;
    grandTotal += total;

    summaryData.push([
      idx + 1,
      cls,
      c.name,
      birthStr,
      c.enrollment_type,
      monthlyFee || null,
      spotCare || null,
      earlyMorning || null,
      extension || null,
      night || null,
      sick || null,
      breakfast || null,
      lunch || null,
      amSnack || null,
      pmSnack || null,
      dinner || null,
      mealSubtotal || null,
      total,
    ]);
  });

  // Total row
  summaryData.push([]);
  const totalRowIdx = summaryData.length;
  summaryData.push([
    null, null, null, null, '合計',
    ...CHARGE_COLUMNS.map(ct =>
      sortedRows.reduce((sum, r) =>
        sum + (r.chargeLines.find(cl => cl.charge_type === ct)?.subtotal || 0), 0
      ) || null
    ),
    sortedRows.reduce((sum, r) => {
      const meals = ['breakfast', 'lunch', 'am_snack', 'pm_snack', 'dinner'];
      return sum + r.chargeLines.filter(cl => meals.includes(cl.charge_type)).reduce((s, cl) => s + cl.subtotal, 0);
    }, 0) || null,
    grandTotal,
  ]);

  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);

  // Column widths
  ws1['!cols'] = [
    { wch: 4 },   // No
    { wch: 8 },   // クラス
    { wch: 16 },  // 氏名
    { wch: 12 },  // 生年月日
    { wch: 6 },   // 区分
    { wch: 12 },  // 月額
    { wch: 12 },  // 一時
    { wch: 10 },  // 早朝
    { wch: 10 },  // 延長
    { wch: 10 },  // 夜間
    { wch: 10 },  // 病児
    { wch: 8 },   // 朝食
    { wch: 8 },   // 昼食
    { wch: 8 },   // AM間食
    { wch: 8 },   // PM間食
    { wch: 8 },   // 夕食
    { wch: 10 },  // 食事小計
    { wch: 12 },  // 合計
  ];

  // Merge title row
  ws1['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 17 } },
  ];

  XLSX.utils.book_append_sheet(wb, ws1, '請求一覧');

  // ═══════════════════════════════════
  // Sheet 2: 請求明細（内訳詳細）
  // ═══════════════════════════════════
  const detailData: (string | number | null)[][] = [];

  detailData.push([`${year}年${month}月 請求明細（内訳）`]);
  detailData.push([]);
  detailData.push([
    '氏名', 'クラス', '区分', '費目', '数量', '単価（円）', '小計（円）', '備考',
  ]);

  for (const row of sortedRows) {
    const c = row.child;
    const cls = ageClassToLabel(c.age_class, c.enrollment_type);

    // Sort charge lines by predefined order
    const sortedLines = [...row.chargeLines].sort((a, b) => {
      const idxA = CHARGE_COLUMNS.indexOf(a.charge_type as typeof CHARGE_COLUMNS[number]);
      const idxB = CHARGE_COLUMNS.indexOf(b.charge_type as typeof CHARGE_COLUMNS[number]);
      return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB);
    });

    for (const cl of sortedLines) {
      detailData.push([
        c.name,
        cls,
        c.enrollment_type,
        CHARGE_TYPE_LABELS[cl.charge_type] || cl.charge_type,
        cl.quantity,
        cl.unit_price,
        cl.subtotal,
        cl.notes || null,
      ]);
    }

    // Child subtotal
    const childTotal = row.chargeLines.reduce((sum, cl) => sum + cl.subtotal, 0);
    detailData.push([
      c.name, null, null, '＝小計', null, null, childTotal, null,
    ]);
  }

  const ws2 = XLSX.utils.aoa_to_sheet(detailData);
  ws2['!cols'] = [
    { wch: 16 },  // 氏名
    { wch: 8 },   // クラス
    { wch: 6 },   // 区分
    { wch: 14 },  // 費目
    { wch: 6 },   // 数量
    { wch: 10 },  // 単価
    { wch: 10 },  // 小計
    { wch: 20 },  // 備考
  ];
  ws2['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
  ];

  XLSX.utils.book_append_sheet(wb, ws2, '請求明細');

  // ═══════════════════════════════════
  // Sheet 3: 単価表（参考用）
  // ═══════════════════════════════════
  if (rules) {
    const priceData: (string | number | null)[][] = [];
    priceData.push([`${year}年度 料金単価表`]);
    priceData.push([]);

    // Monthly fees
    priceData.push(['【月額保育料】']);
    priceData.push(['年齢区分', '第1子', '第2子', '第3子']);
    for (const group of ['0~2歳', '3歳', '4~5歳']) {
      const fees = rules.monthly_fees[group] || {};
      priceData.push([group, fees['1'] ?? 0, fees['2'] ?? 0, fees['3'] ?? 0]);
    }
    priceData.push([]);

    // Spot rates
    priceData.push(['【一時保育（30分単位）】']);
    priceData.push(['年齢区分', '単価（円）']);
    for (const group of ['0~2歳', '3歳', '4~5歳']) {
      priceData.push([group, rules.spot_rates[group] ?? 0]);
    }
    priceData.push([]);

    // Other fees
    priceData.push(['【その他保育料】']);
    priceData.push(['費目', '金額（円）']);
    priceData.push(['早朝保育（1回）', rules.early_morning_fee]);
    priceData.push(['延長保育（1回）', rules.extension_fee]);
    priceData.push(['病児保育（1回）', rules.sick_fee]);
    priceData.push([]);

    // Night fees
    priceData.push(['【夜間保育】']);
    priceData.push(['年齢区分', '金額（円）']);
    for (const group of ['0~2歳', '3歳', '4~5歳']) {
      priceData.push([group, rules.night_fees[group] ?? 0]);
    }
    priceData.push([]);

    // Meal prices
    priceData.push(['【食事代】']);
    priceData.push(['種別', '金額（円）']);
    priceData.push(['朝食', rules.meal_prices.breakfast ?? 150]);
    priceData.push(['昼食', rules.meal_prices.lunch]);
    priceData.push(['AM間食', rules.meal_prices.am_snack]);
    priceData.push(['PM間食', rules.meal_prices.pm_snack]);
    priceData.push(['夕食', rules.meal_prices.dinner]);

    const ws3 = XLSX.utils.aoa_to_sheet(priceData);
    ws3['!cols'] = [
      { wch: 20 },
      { wch: 12 },
      { wch: 12 },
      { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(wb, ws3, '単価表');
  }

  // Write to buffer
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return buf;
}

/**
 * DB から請求データを取得して BillingRow[] を構築するヘルパー
 */
export async function fetchBillingData(
  db: D1Database,
  nurseryId: string,
  year: number,
  month: number,
): Promise<{ rows: BillingRow[]; rules: PricingRules | null; warnings: string[] }> {
  const warnings: string[] = [];

  // 1. Get all children for the nursery
  const childrenResult = await db.prepare(
    `SELECT * FROM children WHERE nursery_id = ? ORDER BY
      CASE enrollment_type WHEN '月極' THEN 0 ELSE 1 END,
      age_class ASC, name ASC`
  ).bind(nurseryId).all();
  const children = childrenResult.results as unknown as Child[];

  if (children.length === 0) {
    warnings.push('園児マスタにデータがありません');
    return { rows: [], rules: null, warnings };
  }

  // 2. Get charge_lines for this month
  const chargeResult = await db.prepare(
    `SELECT * FROM charge_lines WHERE year = ? AND month = ?`
  ).bind(year, month).all();
  const allCharges = chargeResult.results as unknown as ChargeLine[];

  if (allCharges.length === 0) {
    warnings.push(`${year}年${month}月の請求データ（charge_lines）がありません。先にジョブを実行してください。`);
  }

  // 3. Group charge_lines by child_id
  const chargeMap = new Map<string, ChargeLine[]>();
  for (const cl of allCharges) {
    const arr = chargeMap.get(cl.child_id) || [];
    arr.push(cl);
    chargeMap.set(cl.child_id, arr);
  }

  // 4. Build rows (only children with charges, unless we want to show zeros too)
  const rows: BillingRow[] = [];
  for (const child of children) {
    const chargeLines = chargeMap.get(child.id) || [];
    // Include all children — even those with no charges (they'll show zero)
    rows.push({ child, chargeLines });
  }

  // 5. Get pricing rules
  let rules: PricingRules | null = null;
  const { getFiscalYear } = await import('./age-class');
  const fiscalYear = getFiscalYear(year, month);
  const rulesResult = await db.prepare(
    `SELECT rules_json FROM pricing_rules WHERE nursery_id = ? AND fiscal_year = ?`
  ).bind(nurseryId, fiscalYear).first();
  if (rulesResult?.rules_json) {
    try {
      rules = JSON.parse(rulesResult.rules_json as string) as PricingRules;
    } catch {
      warnings.push('料金ルールのJSONパースに失敗しました');
    }
  } else {
    warnings.push(`${fiscalYear}年度の料金ルールが未設定です`);
  }

  return { rows, rules, warnings };
}
