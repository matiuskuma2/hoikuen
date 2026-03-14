// Type definitions for the Ayukko Nursery Automation System
// 
// 型は2つのカテゴリに分かれる:
//   1. DB/API 型 — children, schedule_plans, attendance_records テーブルに対応
//   2. Parsed* 型 — Excel/CSV パーサーの中間表現（ファイル解析結果）
//
// 両者はフィールド構成が異なるため、別インターフェースとして定義する。
// ダッシュボード構築時に Parsed* → DB 型へのマッピングが行われる。

// ═══════════════════════════════════════════════
// Bindings & Environment
// ═══════════════════════════════════════════════

export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
};

export type HonoEnv = {
  Bindings: Bindings;
};

// ═══════════════════════════════════════════════
// Default Nursery ID — ハードコード排除
// 将来マルチテナント対応時は env.NURSERY_ID に移行
// ═══════════════════════════════════════════════

/** デフォルトの nursery_id（全ルートで共通使用） */
export const DEFAULT_NURSERY_ID = 'ayukko_001';

// ═══════════════════════════════════════════════
// Time Boundaries — 全モジュール共通の閾値定数
// excel-parser.ts, usage-calculator.ts, schedules.ts で同じ値を使う
// ═══════════════════════════════════════════════

/**
 * あゆっこ保育園の時間帯境界値（分単位）
 * 
 * 早朝保育: 07:00-07:30 (420-450)
 * 通常保育: 07:30-18:00 (450-1080)
 * 延長保育: 18:00-20:00 (1080-1200)
 * 夜間保育: 20:00以降 (1200+)
 * 
 * ビジネスルール:
 * - 延長保育は 18:00 を基準とする（PricingRules の extension_start に対応）
 * - 夜間保育は 20:00 を基準とする（PricingRules の night_start に対応）
 * - 早朝保育は 07:00-07:30 の間の登園に適用
 */
export const TIME_BOUNDARIES = {
  /** 開園時刻 07:00 = 420分 */
  open: 420,
  /** 早朝保育開始 07:00 = 420分 */
  early_start: 420,
  /** 早朝保育終了 / 通常保育開始 07:30 = 450分 */
  early_end: 450,
  /** 延長保育開始 18:00 = 1080分 */
  extension_start: 1080,
  /** 夜間保育開始 20:00 = 1200分 */
  night_start: 1200,
  /** 閉園時刻 21:00 = 1260分 */
  close: 1260,
} as const;

/**
 * PricingRules 用の time_boundaries 文字列形式
 * (PricingRules.time_boundaries は HH:MM 文字列を使うため)
 */
export const TIME_BOUNDARIES_STR = {
  open: '7:00',
  early_start: '7:00',
  early_end: '7:30',
  extension_start: '18:00',
  night_start: '20:00',
  close: '21:00',
} as const;

// ═══════════════════════════════════════════════
// DB/API Types — テーブル・API レスポンスに対応
// ═══════════════════════════════════════════════

// === Child Master ===
export interface Child {
  id: string;
  nursery_id: string;
  lukumi_id: string | null;
  name: string;
  name_kana: string | null;
  birth_date: string | null;
  age_class: number | null;
  enrollment_type: '月極' | '一時';
  child_order: number;
  enrolled_at: string | null;
  withdrawn_at: string | null;
  collection_method: string;
  bank_info_json: string | null;
  is_allergy: number;
  view_token: string | null;
  created_at: string;
  updated_at: string;
}

// === Schedule Plan (per child per day) — DB テーブル ===
export interface SchedulePlan {
  id: string;
  child_id: string;
  year: number;
  month: number;
  day: number;
  planned_start: string | null; // HH:MM
  planned_end: string | null;
  lunch_flag: number;
  am_snack_flag: number;
  pm_snack_flag: number;
  dinner_flag: number;
  source_file: string | null;
}

// === Attendance Record (from Lukumi) — DB テーブル ===
export interface AttendanceRecord {
  id: string;
  child_id: string;
  year: number;
  month: number;
  day: number;
  actual_checkin: string | null; // HH:MM:SS
  actual_checkout: string | null;
  memo: string | null;
  raw_class: string | null;
  source_file: string | null;
}

// === Usage Fact (calculated) — DB テーブル ===
export interface UsageFact {
  id: string;
  child_id: string;
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
  spot_30min_blocks: number;
  has_lunch: number;
  has_am_snack: number;
  has_pm_snack: number;
  has_dinner: number;
  meal_allergy: number;
  attendance_status: 'present' | 'absent' | 'early_leave' | 'late_arrive' | 'absent_no_plan';
  exception_notes: string | null;
}

// === Charge Line ===
export interface ChargeLine {
  id: string;
  child_id: string;
  year: number;
  month: number;
  charge_type: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  notes: string | null;
}

// === Job ===
export interface Job {
  id: string;
  nursery_id: string;
  year: number;
  month: number;
  status: 'pending' | 'parsing' | 'calculating' | 'generating' | 'completed' | 'failed';
  input_files_json: string | null;
  progress_pct: number;
  error_json: string | null;
  warnings_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// === Pricing Rules ===
export interface PricingRules {
  fiscal_year: number;
  monthly_fees: Record<string, Record<string, number>>;
  spot_rates: Record<string, number>;
  early_morning_fee: number;
  extension_fee: number;
  night_fees: Record<string, number>;
  sick_fee: number;
  meal_prices: {
    lunch: number;
    am_snack: number;
    pm_snack: number;
    dinner: number;
  };
  time_boundaries: {
    open: string;
    early_start: string;
    early_end: string;
    extension_start: string;
    night_start: string;
    close: string;
  };
  rounding: {
    monthly: string;
    spot: string;
  };
}

// ═══════════════════════════════════════════════
// Parsed* Types — Excel/CSV パーサーの中間表現
// excel-parser.ts で生成され、dashboard-builder.ts で消費される
// ═══════════════════════════════════════════════

/** パーサー警告（ファイル解析時に発生する warning/error/info） */
export interface ParseWarning {
  level: 'info' | 'warn' | 'error';
  child_name: string | null;
  message: string;
  suggestion: string | null;
  file?: string;
}

/** ルクミーから解析された出席レコード（DB の AttendanceRecord とは異なる） */
export interface ParsedAttendanceRecord {
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

/** ルクミーから解析された園児情報（DB の Child とは異なる） */
export interface ParsedChildInfo {
  lukumi_id: string;
  name: string;
  name_kana: string | null;
  birth_date: string | null;
  age_class: number | null;
  class_name: string;
  enrollment_type: string;
}

/** Excel予定表から解析された1日分の予定（DB の SchedulePlan とは異なる） */
export interface ParsedSchedulePlan {
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

/** ルクミー×予定表の突合結果 */
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

/** ダッシュボード表示用の UsageFact（DB の UsageFact とは異なる） */
export interface ParsedUsageFact {
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

// ═══════════════════════════════════════════════
// API Response Types
// ═══════════════════════════════════════════════

export interface JobCreateResponse {
  id: string;
  status: string;
  year: number;
  month: number;
}

export interface JobResultResponse {
  id: string;
  status: string;
  outputs: OutputFile[];
  warnings: JobWarning[];
  stats: JobStats;
}

export interface OutputFile {
  file_type: string;
  file_name: string;
  download_url: string;
  purpose: string;
}

export interface JobWarning {
  level: 'warn' | 'error';
  child_name: string | null;
  message: string;
  suggestion: string | null;
}

export interface JobStats {
  children_processed: number;
  children_skipped: number;
  days_processed: number;
  total_warnings: number;
  total_errors: number;
}

// ═══════════════════════════════════════════════
// Time Helper Functions
// ═══════════════════════════════════════════════

/** HH:MM 文字列を分数に変換（non-null 前提） */
export function toMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/** HH:MM 文字列を先頭ゼロなしに変換 (e.g. "07:30" → "7:30") */
export function formatTimeNoLeadingZero(timeStr: string): string {
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1].padStart(2, '0');
  return `${h}:${m}`;
}

/** HH:MM 文字列を Excel シリアル値に変換 */
export function timeToExcelSerial(timeStr: string): number {
  const min = toMinutes(timeStr);
  return min / (24 * 60);
}

/** 年齢クラスを料金グループに変換 */
export function getAgeGroup(ageClass: number): string {
  if (ageClass <= 2) return '0~2歳';
  if (ageClass === 3) return '3歳';
  return '4~5歳';
}

/**
 * null 安全な timeToMinutes — パーサーやルートハンドラ用
 * toMinutes() は non-null 前提だが、パーサー処理では null が頻出するため
 */
export function safeToMinutes(timeStr: string | null | undefined): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
