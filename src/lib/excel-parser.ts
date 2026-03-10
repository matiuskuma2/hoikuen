/**
 * Excel/CSV パーサー (TypeScript + SheetJS)
 * Python Generator の lukumi_parser.py + schedule_parser.py を移植
 * Cloudflare Workers 上で動作
 */
import * as XLSX from 'xlsx';

// ─── 共通型定義 ───
export interface ParseWarning {
  level: 'info' | 'warn' | 'error';
  child_name: string | null;
  message: string;
  suggestion: string | null;
  file?: string;
}

export interface AttendanceRecord {
  lukumi_id: string;
  name: string;
  year: number;
  month: number;
  day: number;
  actual_checkin: string | null;
  actual_checkout: string | null;
  memo: string | null;
  class_name: string;
}

export interface ChildInfo {
  lukumi_id: string;
  name: string;
  name_kana: string | null;
  birth_date: string | null;
  age_class: number | null;
  class_name: string;
  enrollment_type: string;
}

export interface SchedulePlan {
  day: number;
  planned_start: string | null;
  planned_end: string | null;
  lunch_flag: number;
  am_snack_flag: number;
  pm_snack_flag: number;
  dinner_flag: number;
  breakfast_flag: number;
  child_name: string;
  source_file: string;
}

// ─── 名前正規化 (name_matcher.py 移植) ───

const HW_KANA_FROM = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';
const HW_KANA_TO   = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜';

const DAKUTEN_MAP: Record<string, string> = {
  'カ゛': 'ガ', 'キ゛': 'ギ', 'ク゛': 'グ', 'ケ゛': 'ゲ', 'コ゛': 'ゴ',
  'サ゛': 'ザ', 'シ゛': 'ジ', 'ス゛': 'ズ', 'セ゛': 'ゼ', 'ソ゛': 'ゾ',
  'タ゛': 'ダ', 'チ゛': 'ヂ', 'ツ゛': 'ヅ', 'テ゛': 'デ', 'ト゛': 'ド',
  'ハ゛': 'バ', 'ヒ゛': 'ビ', 'フ゛': 'ブ', 'ヘ゛': 'ベ', 'ホ゛': 'ボ',
  'ウ゛': 'ヴ',
  'ハ゜': 'パ', 'ヒ゜': 'ピ', 'フ゜': 'プ', 'ヘ゜': 'ペ', 'ホ゜': 'ポ',
};

export function normalizeName(name: string): string {
  if (!name) return '';
  // Step 1: 全角英数 → 半角
  let result = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0) || 0;
    if (cp >= 0xFF01 && cp <= 0xFF5E) {
      result += String.fromCodePoint(cp - 0xFEE0);
    } else if (ch === '\u3000') {
      result += ' ';
    } else {
      result += ch;
    }
  }
  // Step 2: 半角カタカナ → 全角
  let s = '';
  for (const ch of result) {
    const idx = HW_KANA_FROM.indexOf(ch);
    s += idx >= 0 ? HW_KANA_TO[idx] : ch;
  }
  // Step 3: 濁点結合
  for (const [combo, repl] of Object.entries(DAKUTEN_MAP)) {
    s = s.split(combo).join(repl);
  }
  // Step 4: 区切り記号 → スペース
  s = s.replace(/[・·＝=]/g, ' ');
  // Step 5: 連続スペース
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

// ─── ルクミー登降園データパーサー ───

const COL_PATTERNS: Record<string, string[]> = {
  class_name: ['クラス名', 'クラス', 'class'],
  surname:    ['園児姓', '姓', '苗字'],
  firstname:  ['園児名', '名前'],
  date:       ['日付', '登降園日', 'date'],
  checkin:    ['登園日時', '登園', 'checkin', 'check-in'],
  checkout:   ['降園日時', '降園', 'checkout', 'check-out'],
  memo:       ['メモ', '備考', 'memo'],
  lukumi_id:  ['園児ID', '子どもID', '児童ID', 'id'],
  kana_sei:   ['姓よみ', '姓読み', 'セイ'],
  kana_mei:   ['名よみ', '名読み', 'メイ'],
  birth_date: ['生年月日', '誕生日', 'birthday'],
  age_class:  ['クラス年齢', '年齢', '歳児', 'age'],
};

function detectColumns(rows: any[][]): { colMap: Record<string, number> | null; headerIdx: number; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  
  for (let headerIdx = 0; headerIdx < Math.min(5, rows.length); headerIdx++) {
    const header = rows[headerIdx];
    const colMap: Record<string, number> = {};
    const usedCols = new Set<number>();
    
    // Pass 1: 完全一致
    for (let colIdx = 0; colIdx < header.length; colIdx++) {
      if (header[colIdx] == null) continue;
      const cellStr = String(header[colIdx]).trim();
      for (const [field, patterns] of Object.entries(COL_PATTERNS)) {
        if (field in colMap) continue;
        for (const pattern of patterns) {
          if (pattern.toLowerCase() === cellStr.toLowerCase()) {
            colMap[field] = colIdx;
            usedCols.add(colIdx);
            break;
          }
        }
      }
    }
    
    // Pass 2: 部分一致
    for (let colIdx = 0; colIdx < header.length; colIdx++) {
      if (header[colIdx] == null || usedCols.has(colIdx)) continue;
      const cellStr = String(header[colIdx]).trim();
      for (const [field, patterns] of Object.entries(COL_PATTERNS)) {
        if (field in colMap) continue;
        for (const pattern of patterns) {
          if (pattern.length >= 2 && cellStr.includes(pattern)) {
            colMap[field] = colIdx;
            usedCols.add(colIdx);
            break;
          }
        }
      }
    }
    
    // Fallback: firstname
    if (!('firstname' in colMap) && 'surname' in colMap) {
      const nextCol = colMap.surname + 1;
      if (nextCol < header.length && !usedCols.has(nextCol)) {
        colMap.firstname = nextCol;
        usedCols.add(nextCol);
      }
    }
    
    // 必要最低限のカラムが揃っているか
    if ('surname' in colMap && 'date' in colMap && 'lukumi_id' in colMap) {
      if (!('checkin' in colMap)) colMap.checkin = 4;
      if (!('checkout' in colMap)) colMap.checkout = 5;
      return { colMap, headerIdx, warnings };
    }
  }
  
  // Fallback: 標準列順
  warnings.push({
    level: 'warn', child_name: null,
    message: 'ヘッダー自動検出できず。ルクミー標準列順を仮定します',
    suggestion: null,
  });
  return {
    colMap: {
      class_name: 0, surname: 1, firstname: 2, date: 3,
      checkin: 4, checkout: 5, memo: 6, lukumi_id: 7,
      kana_sei: 8, kana_mei: 9, birth_date: 10, age_class: 11,
    },
    headerIdx: 0,
    warnings,
  };
}

function parseDate(val: any): Date | null {
  if (val == null) return null;
  if (val instanceof Date) return val;
  
  // SheetJS may return a number (serial date)
  if (typeof val === 'number') {
    try {
      const d = XLSX.SSF.parse_date_code(val);
      return new Date(d.y, d.m - 1, d.d);
    } catch { return null; }
  }
  
  const s = String(val).trim();
  if (!s) return null;
  
  // Try various formats
  const formats = [
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
    /^(\d{4})年(\d{1,2})月(\d{1,2})日/,
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  ];
  for (const fmt of formats) {
    const m = s.match(fmt);
    if (m) {
      const parts = m.slice(1).map(Number);
      if (fmt === formats[2]) {
        return new Date(parts[2], parts[0] - 1, parts[1]);
      }
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }
  
  // Fallback: Date.parse
  const ts = Date.parse(s);
  if (!isNaN(ts)) return new Date(ts);
  
  return null;
}

function parseTimeValue(val: any): string | null {
  if (val == null) return null;
  
  if (val instanceof Date) {
    const h = val.getHours();
    const m = val.getMinutes();
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  
  // Excel time serial (0.0-1.0)
  if (typeof val === 'number') {
    if (val >= 0 && val < 1) {
      const totalMin = Math.round(val * 24 * 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    // SheetJS date serial containing time
    if (val > 1) {
      try {
        const d = XLSX.SSF.parse_date_code(val);
        return `${String(d.H).padStart(2, '0')}:${String(d.M).padStart(2, '0')}`;
      } catch { return null; }
    }
    return null;
  }
  
  const s = String(val).trim();
  if (!s) return null;
  
  // HH:MM or HH:MM:SS
  const match = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const h = parseInt(match[1]);
    const m = parseInt(match[2]);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  
  return null;
}

function parseLukumiRow(row: any[], colMap: Record<string, number>, targetYear: number, targetMonth: number): {
  record: AttendanceRecord | null;
  childInfo: ChildInfo | null;
} {
  const get = (field: string) => {
    const idx = colMap[field];
    if (idx == null || idx >= row.length) return null;
    return row[idx];
  };
  
  const surname = String(get('surname') || '').trim();
  const firstname = 'firstname' in colMap ? String(get('firstname') || '').trim() : '';
  const lukumiId = String(get('lukumi_id') || '').trim();
  const fullName = firstname ? `${surname} ${firstname}`.trim() : surname;
  
  if (!fullName || !lukumiId) return { record: null, childInfo: null };
  
  const dt = parseDate(get('date'));
  if (!dt) return { record: null, childInfo: null };
  if (dt.getFullYear() !== targetYear || dt.getMonth() + 1 !== targetMonth) {
    return { record: null, childInfo: null };
  }
  
  const record: AttendanceRecord = {
    lukumi_id: lukumiId,
    name: fullName,
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    actual_checkin: parseTimeValue(get('checkin')),
    actual_checkout: parseTimeValue(get('checkout')),
    memo: get('memo') ? String(get('memo')).trim() : null,
    class_name: String(get('class_name') || '').trim(),
  };
  
  const kanaSei = get('kana_sei') ? String(get('kana_sei')).trim() : '';
  const kanaMei = get('kana_mei') ? String(get('kana_mei')).trim() : '';
  const nameKana = `${kanaSei} ${kanaMei}`.trim() || null;
  
  let birthDate: string | null = null;
  const bd = get('birth_date');
  if (bd) {
    const parsed = parseDate(bd);
    if (parsed) {
      birthDate = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    }
  }
  
  let ageClass: number | null = null;
  const ac = get('age_class');
  if (ac != null) {
    const n = parseInt(String(ac));
    if (!isNaN(n)) ageClass = n;
  }
  
  const childInfo: ChildInfo = {
    lukumi_id: lukumiId,
    name: fullName,
    name_kana: nameKana,
    birth_date: birthDate,
    age_class: ageClass,
    class_name: String(get('class_name') || '').trim(),
    enrollment_type: '月極',
  };
  
  return { record, childInfo };
}

export function parseLukumi(data: ArrayBuffer, filename: string, targetYear: number, targetMonth: number): {
  attendance: AttendanceRecord[];
  children: ChildInfo[];
  warnings: ParseWarning[];
} {
  const warnings: ParseWarning[] = [];
  
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: 'array', cellDates: true });
  } catch (e) {
    return {
      attendance: [], children: [],
      warnings: [{ level: 'error', child_name: null, message: `ルクミーファイルを開けません: ${e}`, suggestion: 'ファイル形式を確認してください' }],
    };
  }
  
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) {
    return {
      attendance: [], children: [],
      warnings: [{ level: 'error', child_name: null, message: 'シートが見つかりません', suggestion: null }],
    };
  }
  
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy/mm/dd' });
  // Also get raw values for time parsing
  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  
  if (rows.length < 2) {
    return {
      attendance: [], children: [],
      warnings: [{ level: 'error', child_name: null, message: 'データ行がありません', suggestion: null }],
    };
  }
  
  const { colMap, headerIdx, warnings: hw } = detectColumns(rows);
  warnings.push(...hw);
  if (!colMap) return { attendance: [], children: [], warnings };
  
  const attendance: AttendanceRecord[] = [];
  const childrenMap = new Map<string, ChildInfo>();
  
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const { record, childInfo } = parseLukumiRow(rawRows[i], colMap, targetYear, targetMonth);
    if (record) attendance.push(record);
    if (childInfo && !childrenMap.has(childInfo.lukumi_id)) {
      childrenMap.set(childInfo.lukumi_id, childInfo);
    }
  }
  
  if (attendance.length === 0) {
    warnings.push({
      level: 'error', child_name: null,
      message: `ルクミーデータから${targetYear}年${targetMonth}月の出席レコードが0件です`,
      suggestion: 'ファイルの期間を確認してください',
    });
  }
  
  return { attendance, children: Array.from(childrenMap.values()), warnings };
}

// ─── 児童利用予定表パーサー ───

interface LayoutConfig {
  format: string;
  yearPos: [number, number];
  monthPos: [number, number];
  namePos: [number, number];
  leftDateCol: number;
  leftStartCol: number;
  leftEndCol: number;
  leftLunchCol: number;
  leftAmSnackCol: number;
  leftPmSnackCol: number;
  leftDinnerCol: number;
  rightDateCol: number;
  rightStartCol: number;
  rightEndCol: number;
  rightLunchCol: number;
  rightAmSnackCol: number;
  rightPmSnackCol: number;
  rightDinnerCol: number;
  hasSeparateSnacks: boolean;
}

function getCell(ws: XLSX.WorkSheet, row: number, col: number): any {
  const addr = XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
  const cell = ws[addr];
  return cell ? cell.v : undefined;
}

function detectLayout(ws: XLSX.WorkSheet): LayoutConfig {
  const f11 = String(getCell(ws, 11, 6) || '').trim();
  const g11 = String(getCell(ws, 11, 7) || '').trim();
  const hasNewHeader = f11.includes('昼食') || g11.includes('おやつ');
  
  const f1 = getCell(ws, 1, 6);
  const j1 = getCell(ws, 1, 10);
  
  let f1IsYear = false, j1IsMonth = false;
  if (f1 != null) { const n = parseInt(String(f1)); if (n >= 2020 && n <= 2030) f1IsYear = true; }
  if (j1 != null) { const n = parseInt(String(j1)); if (n >= 1 && n <= 12) j1IsMonth = true; }
  
  const isNewFormat = hasNewHeader || (f1IsYear && j1IsMonth);
  
  if (isNewFormat) {
    return {
      format: 'new',
      yearPos: [1, 6], monthPos: [1, 10], namePos: [6, 4],
      leftDateCol: 2, leftStartCol: 4, leftEndCol: 5,
      leftLunchCol: 6, leftAmSnackCol: 7, leftPmSnackCol: 8, leftDinnerCol: 9,
      rightDateCol: 10, rightStartCol: 12, rightEndCol: 13,
      rightLunchCol: 14, rightAmSnackCol: 15, rightPmSnackCol: 16, rightDinnerCol: 17,
      hasSeparateSnacks: true,
    };
  }
  return {
    format: 'legacy',
    yearPos: [1, 10], monthPos: [1, 13], namePos: [6, 2],
    leftDateCol: 2, leftStartCol: 4, leftEndCol: 7,
    leftLunchCol: 10, leftAmSnackCol: 11, leftPmSnackCol: 11, leftDinnerCol: 12,
    rightDateCol: 13, rightStartCol: 15, rightEndCol: 18,
    rightLunchCol: 21, rightAmSnackCol: 22, rightPmSnackCol: 22, rightDinnerCol: 23,
    hasSeparateSnacks: false,
  };
}

function parseTimeCell(val: any): string | null {
  if (val == null) return null;
  if (val instanceof Date) {
    return `${String(val.getHours()).padStart(2, '0')}:${String(val.getMinutes()).padStart(2, '0')}`;
  }
  if (typeof val === 'number') {
    if (val >= 0 && val < 1) {
      const totalMin = Math.round(val * 24 * 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    if (val > 0 && val < 24 && val === Math.floor(val)) {
      return `${String(val).padStart(2, '0')}:00`;
    }
    // SheetJS date serial
    if (val > 1) {
      try {
        const d = XLSX.SSF.parse_date_code(val);
        return `${String(d.H).padStart(2, '0')}:${String(d.M).padStart(2, '0')}`;
      } catch { return null; }
    }
    return null;
  }
  const s = String(val).trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${String(parseInt(m[1])).padStart(2, '0')}:${m[2]}`;
  // "900" → "09:00"
  const m2 = s.match(/^(\d{1,2})(\d{2})$/);
  if (m2) {
    const h = parseInt(m2[1]), mi = parseInt(m2[2]);
    if (h <= 23 && mi <= 59) return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  return null;
}

function isFlag(val: any): boolean {
  if (val == null) return false;
  const s = String(val).trim();
  return ['〇', '○', 'O', 'o', '1', 'TRUE', 'true', '◯', '●', '✓', '✔'].includes(s);
}

function extractDay(val: any): number | null {
  if (val == null) return null;
  if (val instanceof Date) return val.getDate();
  if (typeof val === 'number') {
    if (val >= 1 && val <= 31 && val === Math.floor(val)) return val;
    // SheetJS date serial
    if (val > 31) {
      try {
        const d = XLSX.SSF.parse_date_code(val);
        if (d.d >= 1 && d.d <= 31) return d.d;
      } catch { /* ignore */ }
    }
    return null;
  }
  const n = parseInt(String(val).trim());
  if (n >= 1 && n <= 31) return n;
  return null;
}

function safeInt(val: any): number | null {
  if (val == null) return null;
  const n = parseInt(String(val));
  return isNaN(n) ? null : n;
}

function timeToMinutes(t: string | null): number | null {
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length < 2) return null;
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function parseSingleSheet(ws: XLSX.WorkSheet, filename: string, sheetLabel: string, targetYear: number, targetMonth: number): {
  plans: Record<number, SchedulePlan>;
  childName: string | null;
  warnings: ParseWarning[];
} {
  const warnings: ParseWarning[] = [];
  const plans: Record<number, SchedulePlan> = {};
  
  const layout = detectLayout(ws);
  
  // Child name
  let childName: string | null = null;
  const nameVal = getCell(ws, layout.namePos[0], layout.namePos[1]);
  if (nameVal) childName = normalizeName(String(nameVal));
  
  if (!childName) {
    // Fallback positions
    const fallbacks: [number, number][] = [[6, 2], [6, 3], [6, 4], [5, 2], [5, 4]];
    for (const [r, c] of fallbacks) {
      if (r === layout.namePos[0] && c === layout.namePos[1]) continue;
      const v = getCell(ws, r, c);
      if (v) {
        const s = String(v).trim();
        if (s && !s.includes('お子様') && !s.includes('（') && !s.includes('申込')) {
          childName = normalizeName(s);
          break;
        }
      }
    }
  }
  
  if (!childName) {
    // Try sheet name
    const sheetName = ws['!ref'] ? sheetLabel.match(/\[(.+)\]$/)?.[1] : null;
    // Fallback: use sheetLabel
    return { plans, childName: null, warnings };
  }
  
  // Year/month check
  const fileYear = safeInt(getCell(ws, layout.yearPos[0], layout.yearPos[1]));
  const fileMonth = safeInt(getCell(ws, layout.monthPos[0], layout.monthPos[1]));
  
  if (fileYear && fileMonth && (fileYear !== targetYear || fileMonth !== targetMonth)) {
    warnings.push({
      level: 'warn', child_name: childName,
      message: `「${sheetLabel}」の年月(${fileYear}年${fileMonth}月)が対象月(${targetYear}年${targetMonth}月)と不一致`,
      suggestion: '正しいファイルか確認してください', file: filename,
    });
  }
  
  // Parse left half (days 1-15)
  for (let i = 0; i < 15; i++) {
    const row = 12 + i;
    const day = extractDay(getCell(ws, row, layout.leftDateCol));
    if (day == null || day < 1 || day > 31) continue;
    
    const start = parseTimeCell(getCell(ws, row, layout.leftStartCol));
    const end = parseTimeCell(getCell(ws, row, layout.leftEndCol));
    if (!start && !end) continue;
    
    let lunchFlag: number, amSnackFlag: number, pmSnackFlag: number, dinnerFlag: number;
    
    if (layout.hasSeparateSnacks) {
      lunchFlag = isFlag(getCell(ws, row, layout.leftLunchCol)) ? 1 : 0;
      amSnackFlag = isFlag(getCell(ws, row, layout.leftAmSnackCol)) ? 1 : 0;
      pmSnackFlag = isFlag(getCell(ws, row, layout.leftPmSnackCol)) ? 1 : 0;
      dinnerFlag = isFlag(getCell(ws, row, layout.leftDinnerCol)) ? 1 : 0;
    } else {
      lunchFlag = isFlag(getCell(ws, row, layout.leftLunchCol)) ? 1 : 0;
      const snack = isFlag(getCell(ws, row, layout.leftAmSnackCol));
      dinnerFlag = isFlag(getCell(ws, row, layout.leftDinnerCol)) ? 1 : 0;
      amSnackFlag = 0; pmSnackFlag = 0;
      if (snack) {
        const sMin = timeToMinutes(start);
        const eMin = timeToMinutes(end);
        if (sMin != null && sMin <= 600) amSnackFlag = 1;
        if (eMin != null && eMin >= 900) pmSnackFlag = 1;
        if (!amSnackFlag && !pmSnackFlag) pmSnackFlag = 1;
      }
    }
    
    plans[day] = {
      day, planned_start: start, planned_end: end,
      lunch_flag: lunchFlag, am_snack_flag: amSnackFlag,
      pm_snack_flag: pmSnackFlag, dinner_flag: dinnerFlag,
      breakfast_flag: 0, // Excelに朝食列がなければ0
      child_name: childName, source_file: filename,
    };
  }
  
  // Parse right half (days 16-31)
  for (let i = 0; i < 16; i++) {
    const row = 12 + i;
    const day = extractDay(getCell(ws, row, layout.rightDateCol));
    if (day == null || day < 1 || day > 31) continue;
    
    const start = parseTimeCell(getCell(ws, row, layout.rightStartCol));
    const end = parseTimeCell(getCell(ws, row, layout.rightEndCol));
    if (!start && !end) continue;
    
    let lunchFlag: number, amSnackFlag: number, pmSnackFlag: number, dinnerFlag: number;
    
    if (layout.hasSeparateSnacks) {
      lunchFlag = isFlag(getCell(ws, row, layout.rightLunchCol)) ? 1 : 0;
      amSnackFlag = isFlag(getCell(ws, row, layout.rightAmSnackCol)) ? 1 : 0;
      pmSnackFlag = isFlag(getCell(ws, row, layout.rightPmSnackCol)) ? 1 : 0;
      dinnerFlag = isFlag(getCell(ws, row, layout.rightDinnerCol)) ? 1 : 0;
    } else {
      lunchFlag = isFlag(getCell(ws, row, layout.rightLunchCol)) ? 1 : 0;
      const snack = isFlag(getCell(ws, row, layout.rightAmSnackCol));
      dinnerFlag = isFlag(getCell(ws, row, layout.rightDinnerCol)) ? 1 : 0;
      amSnackFlag = 0; pmSnackFlag = 0;
      if (snack) {
        const sMin = timeToMinutes(start);
        const eMin = timeToMinutes(end);
        if (sMin != null && sMin <= 600) amSnackFlag = 1;
        if (eMin != null && eMin >= 900) pmSnackFlag = 1;
        if (!amSnackFlag && !pmSnackFlag) pmSnackFlag = 1;
      }
    }
    
    plans[day] = {
      day, planned_start: start, planned_end: end,
      lunch_flag: lunchFlag, am_snack_flag: amSnackFlag,
      pm_snack_flag: pmSnackFlag, dinner_flag: dinnerFlag,
      breakfast_flag: 0,
      child_name: childName, source_file: filename,
    };
  }
  
  if (Object.keys(plans).length === 0) {
    warnings.push({
      level: 'warn', child_name: childName,
      message: `「${sheetLabel}」: 有効な利用予定が0件です`,
      suggestion: '予定表の内容が正しいか確認してください', file: filename,
    });
  }
  
  return { plans, childName, warnings };
}

export function parseSchedule(data: ArrayBuffer, filename: string, targetYear: number, targetMonth: number): {
  results: Array<{ plans: Record<number, SchedulePlan>; childName: string }>;
  warnings: ParseWarning[];
} {
  const warnings: ParseWarning[] = [];
  const results: Array<{ plans: Record<number, SchedulePlan>; childName: string }> = [];
  
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: 'array', cellDates: true });
  } catch (e) {
    return {
      results: [],
      warnings: [{ level: 'error', child_name: null, message: `予定表を開けません: ${filename} (${e})`, suggestion: 'ファイル形式を確認してください', file: filename }],
    };
  }
  
  // Determine sheets to process
  let sheetNames = wb.SheetNames;
  if (sheetNames.includes('原本')) {
    sheetNames = ['原本'];
  }
  
  for (const sheetName of sheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    
    const sheetLabel = `${filename}[${sheetName}]`;
    const { plans, childName, warnings: sw } = parseSingleSheet(ws, filename, sheetLabel, targetYear, targetMonth);
    warnings.push(...sw);
    
    if (childName) {
      results.push({ plans, childName });
    }
  }
  
  return { results, warnings };
}

// ─── Usage Facts 計算 (usage_calculator.py 移植) ───

export interface UsageFact {
  child_id: string;
  child_name: string;
  year: number;
  month: number;
  day: number;
  billing_start: string | null;
  billing_end: string | null;
  billing_minutes: number | null;
  is_early_morning: number;
  is_extension: number;
  is_night: number;
  is_sick: number;
  has_breakfast: number;
  has_lunch: number;
  has_am_snack: number;
  has_pm_snack: number;
  has_dinner: number;
  attendance_status: string;
  exception_notes: string | null;
  planned_start: string | null;
  planned_end: string | null;
  actual_checkin: string | null;
  actual_checkout: string | null;
}

const TIME_BOUNDARIES = {
  early_start: 420, // 07:00
  early_end: 450,   // 07:30
  ext_start: 1200,  // 20:00
  night_start: 1260, // 21:00
};

function toMin(t: string | null): number {
  if (!t) return 0;
  const p = t.split(':');
  return (parseInt(p[0]) || 0) * 60 + (parseInt(p[1]) || 0);
}

function fmtTime(t: string): string {
  const p = t.split(':');
  return `${parseInt(p[0])}:${p[1].padStart(2, '0')}`;
}

export interface MatchedChild {
  id: string;
  lukumi_id: string;
  name: string;
  name_norm: string;
  name_kana: string | null;
  age_class: number | null;
  enrollment_type: string;
  birth_date: string | null;
  class_name: string;
  has_schedule: boolean;
  schedule_file: string | null;
  is_allergy: number;
  child_order: number;
}

export function matchChildren(
  lukumiChildren: ChildInfo[],
  scheduleNames: string[],
): { children: MatchedChild[]; warnings: ParseWarning[]; unmatched: string[] } {
  const warnings: ParseWarning[] = [];
  const children: MatchedChild[] = [];
  
  const byNorm = new Map<string, MatchedChild>();
  const byNoSpace = new Map<string, MatchedChild>();
  const bySurname = new Map<string, MatchedChild[]>();
  
  for (const lc of lukumiChildren) {
    const child: MatchedChild = {
      id: lc.lukumi_id,
      lukumi_id: lc.lukumi_id,
      name: lc.name,
      name_norm: normalizeName(lc.name),
      name_kana: lc.name_kana,
      age_class: lc.age_class,
      enrollment_type: lc.enrollment_type || '月極',
      birth_date: lc.birth_date,
      class_name: lc.class_name || '',
      has_schedule: false,
      schedule_file: null,
      is_allergy: 0,
      child_order: 1,
    };
    children.push(child);
    byNorm.set(child.name_norm, child);
    byNoSpace.set(child.name_norm.replace(/ /g, ''), child);
    const surname = child.name_norm.split(' ')[0];
    if (!bySurname.has(surname)) bySurname.set(surname, []);
    bySurname.get(surname)!.push(child);
  }
  
  const unmatched: string[] = [];
  for (const sname of scheduleNames) {
    const snorm = normalizeName(sname);
    const snospace = snorm.replace(/ /g, '');
    const ssurname = snorm.split(' ')[0];
    
    let matched = byNorm.get(snorm) || byNoSpace.get(snospace);
    if (!matched && bySurname.has(ssurname)) {
      const candidates = bySurname.get(ssurname)!;
      if (candidates.length === 1) {
        matched = candidates[0];
        warnings.push({ level: 'warn', child_name: sname, message: `予定表「${sname}」→姓一致で「${matched.name}」に突合`, suggestion: null });
      }
    }
    
    if (matched) {
      matched.has_schedule = true;
      matched.schedule_file = sname;
    } else {
      unmatched.push(sname);
    }
  }
  
  return { children, warnings, unmatched };
}

export function computeUsageFacts(
  children: MatchedChild[],
  allPlans: Map<string, Record<number, SchedulePlan>>,
  attendance: AttendanceRecord[],
  year: number,
  month: number,
): UsageFact[] {
  // Index attendance by (lukumi_id, day)
  const attByKey = new Map<string, AttendanceRecord>();
  for (const a of attendance) {
    attByKey.set(`${a.lukumi_id}_${a.day}`, a);
  }
  
  const daysInMonth = new Date(year, month, 0).getDate();
  const facts: UsageFact[] = [];
  
  for (const child of children) {
    const childNorm = normalizeName(child.name);
    let childPlans: Record<number, SchedulePlan> = {};
    for (const [planName, plans] of allPlans) {
      if (normalizeName(planName) === childNorm || normalizeName(planName).replace(/ /g, '') === childNorm.replace(/ /g, '')) {
        childPlans = plans;
        break;
      }
    }
    
    for (let day = 1; day <= daysInMonth; day++) {
      const plan = childPlans[day] || null;
      const actual = attByKey.get(`${child.lukumi_id}_${day}`) || null;
      facts.push(computeSingleFact(child, plan, actual, year, month, day));
    }
  }
  
  return facts;
}

function computeSingleFact(
  child: MatchedChild,
  plan: SchedulePlan | null,
  actual: AttendanceRecord | null,
  year: number, month: number, day: number,
): UsageFact {
  const fact: UsageFact = {
    child_id: child.lukumi_id,
    child_name: child.name,
    year, month, day,
    billing_start: null, billing_end: null, billing_minutes: null,
    is_early_morning: 0, is_extension: 0, is_night: 0, is_sick: 0,
    has_breakfast: 0, has_lunch: 0, has_am_snack: 0, has_pm_snack: 0, has_dinner: 0,
    attendance_status: 'absent_no_plan',
    exception_notes: null,
    planned_start: plan?.planned_start || null,
    planned_end: plan?.planned_end || null,
    actual_checkin: actual?.actual_checkin || null,
    actual_checkout: actual?.actual_checkout || null,
  };
  
  const hasPlan = plan != null && plan.planned_start != null;
  const hasCheckin = actual != null && actual.actual_checkin != null;
  const hasCheckout = actual != null && actual.actual_checkout != null;
  
  if (!hasPlan && !hasCheckin) {
    fact.attendance_status = 'absent_no_plan';
    return fact;
  }
  
  if (hasPlan && !hasCheckin) {
    fact.attendance_status = 'absent';
    fact.exception_notes = '予定あり・実績なし（欠席）';
    fact.has_breakfast = plan!.breakfast_flag || 0;
    fact.has_lunch = plan!.lunch_flag || 0;
    fact.has_am_snack = plan!.am_snack_flag || 0;
    fact.has_pm_snack = plan!.pm_snack_flag || 0;
    fact.has_dinner = plan!.dinner_flag || 0;
    return fact;
  }
  
  let billingStart: string;
  let billingEnd: string | null = null;
  const notes: string[] = [];
  
  if (hasPlan && hasCheckin) {
    billingStart = plan!.planned_start!;
    if (hasCheckout && plan!.planned_end) {
      const peMin = toMin(plan!.planned_end);
      const aeMin = toMin(actual!.actual_checkout);
      billingEnd = aeMin > peMin ? actual!.actual_checkout! : plan!.planned_end;
    } else if (hasCheckout) {
      billingEnd = actual!.actual_checkout!;
    } else if (plan!.planned_end) {
      billingEnd = plan!.planned_end;
    }
    fact.attendance_status = 'present';
    
    if (hasCheckout && plan!.planned_end) {
      if (toMin(plan!.planned_end) - toMin(actual!.actual_checkout) > 30) {
        fact.attendance_status = 'early_leave';
      }
    }
    if (plan!.planned_start) {
      if (toMin(actual!.actual_checkin) - toMin(plan!.planned_start) > 15) {
        fact.attendance_status = 'late_arrive';
      }
    }
  } else {
    billingStart = actual!.actual_checkin!;
    billingEnd = hasCheckout ? actual!.actual_checkout! : null;
    notes.push('予定表未提出・実績のみ');
    fact.attendance_status = 'present';
  }
  
  if (!billingEnd) notes.push('降園未記録');
  
  fact.billing_start = fmtTime(billingStart);
  fact.billing_end = billingEnd ? fmtTime(billingEnd) : null;
  
  if (fact.billing_start && fact.billing_end) {
    const mins = toMin(fact.billing_end) - toMin(fact.billing_start);
    fact.billing_minutes = mins < 0 ? 0 : mins;
  }
  
  const startMin = toMin(fact.billing_start);
  const endMin = fact.billing_end ? toMin(fact.billing_end) : null;
  
  fact.is_early_morning = (startMin < TIME_BOUNDARIES.early_end && startMin >= TIME_BOUNDARIES.early_start) ? 1 : 0;
  fact.is_extension = (endMin != null && endMin > TIME_BOUNDARIES.ext_start) ? 1 : 0;
  fact.is_night = (endMin != null && endMin > TIME_BOUNDARIES.night_start) ? 1 : 0;
  
  // Meal flags
  if (fact.attendance_status === 'present' || fact.attendance_status === 'late_arrive') {
    if (hasPlan) {
      fact.has_breakfast = plan!.breakfast_flag || 0;
      fact.has_lunch = plan!.lunch_flag || 0;
      fact.has_am_snack = plan!.am_snack_flag || 0;
      fact.has_pm_snack = plan!.pm_snack_flag || 0;
      fact.has_dinner = plan!.dinner_flag || 0;
    } else {
      fact.has_breakfast = startMin < 480 ? 1 : 0;
      fact.has_lunch = (startMin <= 720 && (endMin || 0) >= 720) ? 1 : 0;
      fact.has_am_snack = startMin <= 600 ? 1 : 0;
      fact.has_pm_snack = (endMin || 0) >= 900 ? 1 : 0;
      fact.has_dinner = (endMin || 0) >= 1080 ? 1 : 0;
    }
    if (fact.attendance_status === 'early_leave' && endMin != null) {
      if (endMin < 720) fact.has_lunch = 0;
      if (endMin < 900) fact.has_pm_snack = 0;
      if (endMin < 1080) fact.has_dinner = 0;
    }
  }
  
  if (notes.length) fact.exception_notes = notes.join(' / ');
  return fact;
}
