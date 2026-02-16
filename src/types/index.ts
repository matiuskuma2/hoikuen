// Type definitions for the Ayukko Nursery Automation System

export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
};

export type HonoEnv = {
  Bindings: Bindings;
};

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
  created_at: string;
  updated_at: string;
}

// === Schedule Plan (per child per day) ===
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

// === Attendance Record (from Lukumi) ===
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

// === Usage Fact (calculated) ===
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

// === API Response Types ===
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

// === Time Helper ===
export function toMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

export function formatTimeNoLeadingZero(timeStr: string): string {
  const parts = timeStr.split(':');
  const h = parseInt(parts[0]);
  const m = parts[1].padStart(2, '0');
  return `${h}:${m}`;
}

export function timeToExcelSerial(timeStr: string): number {
  const min = toMinutes(timeStr);
  return min / (24 * 60);
}

export function getAgeGroup(ageClass: number): string {
  if (ageClass <= 2) return '0~2歳';
  if (ageClass === 3) return '3歳';
  return '4~5歳';
}
