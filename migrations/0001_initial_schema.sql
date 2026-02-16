-- あゆっこ保育園 業務自動化システム
-- Migration: 0001_initial_schema.sql
-- Created: 2026-02-16

-- ============================================================
-- 園情報
-- ============================================================
CREATE TABLE IF NOT EXISTS nurseries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL DEFAULT 'あゆっこ',
  settings_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- 園児マスタ
-- ============================================================
CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  lukumi_id TEXT,                    -- ルクミー園児ID (安定キー)
  name TEXT NOT NULL,                -- 氏名（全角スペース正規化済み）
  name_kana TEXT,                    -- フリガナ
  birth_date TEXT,                   -- 生年月日 (YYYY-MM-DD)
  age_class INTEGER,                 -- 歳児クラス (0-5)
  enrollment_type TEXT NOT NULL CHECK(enrollment_type IN ('月極','一時')),
  child_order INTEGER DEFAULT 1,     -- 第○子
  enrolled_at TEXT,                  -- 入園日
  withdrawn_at TEXT,                 -- 退園日
  collection_method TEXT DEFAULT '口座振替',
  bank_info_json TEXT,               -- 銀行口座情報(JSON)
  is_allergy INTEGER DEFAULT 0,      -- アレルギー食フラグ
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_children_lukumi ON children(lukumi_id);
CREATE INDEX IF NOT EXISTS idx_children_nursery ON children(nursery_id);
CREATE INDEX IF NOT EXISTS idx_children_name ON children(name);

-- ============================================================
-- 利用予定（月次・日別）
-- ============================================================
CREATE TABLE IF NOT EXISTS schedule_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  planned_start TEXT,                -- 予定登園 (HH:MM)
  planned_end TEXT,                  -- 予定降園 (HH:MM)
  lunch_flag INTEGER DEFAULT 0,
  am_snack_flag INTEGER DEFAULT 0,
  pm_snack_flag INTEGER DEFAULT 0,
  dinner_flag INTEGER DEFAULT 0,
  source_file TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- ============================================================
-- 登降園実績（ルクミー）
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  actual_checkin TEXT,               -- 実績登園 (HH:MM:SS)
  actual_checkout TEXT,              -- 実績降園 (HH:MM:SS)
  memo TEXT,
  raw_class TEXT,                    -- 元クラス名
  source_file TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- ============================================================
-- 利用実績（計算結果）
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,

  billing_start TEXT,                -- 課金開始 = planned_start (あれば) else actual_checkin
  billing_end TEXT,                  -- 課金終了 = max(planned_end, actual_checkout)
  billing_minutes INTEGER,

  is_early_morning INTEGER DEFAULT 0,
  is_extension INTEGER DEFAULT 0,
  is_night INTEGER DEFAULT 0,
  is_sick INTEGER DEFAULT 0,

  spot_30min_blocks INTEGER DEFAULT 0,

  has_lunch INTEGER DEFAULT 0,
  has_am_snack INTEGER DEFAULT 0,
  has_pm_snack INTEGER DEFAULT 0,
  has_dinner INTEGER DEFAULT 0,
  meal_allergy INTEGER DEFAULT 0,

  attendance_status TEXT DEFAULT 'present'
    CHECK(attendance_status IN ('present','absent','early_leave','late_arrive','absent_no_plan')),

  exception_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- ============================================================
-- 請求明細行
-- ============================================================
CREATE TABLE IF NOT EXISTS charge_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  charge_type TEXT NOT NULL CHECK(charge_type IN (
    'monthly_fee','spot_care','early_morning','extension',
    'night','sick','lunch','am_snack','pm_snack','dinner'
  )),
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, charge_type)
);

-- ============================================================
-- 料金ルール
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_rules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  fiscal_year INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  source_file TEXT,
  extracted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, fiscal_year)
);

-- ============================================================
-- ジョブ管理
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','parsing','calculating','generating','completed','failed')),
  input_files_json TEXT,
  progress_pct INTEGER DEFAULT 0,
  error_json TEXT,
  warnings_json TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_nursery ON jobs(nursery_id, year, month);

-- ============================================================
-- ジョブログ
-- ============================================================
CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- 生成ファイル
-- ============================================================
CREATE TABLE IF NOT EXISTS output_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  file_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  file_size INTEGER,
  content_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- テンプレート管理
-- ============================================================
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  template_type TEXT NOT NULL CHECK(template_type IN (
    'daily_report','billing_detail','parent_statement'
  )),
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, template_type)
);

-- ============================================================
-- 名前突合マッピング
-- ============================================================
CREATE TABLE IF NOT EXISTS name_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  source_system TEXT NOT NULL,
  original_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  child_id TEXT REFERENCES children(id),
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, source_system, original_name)
);

-- ============================================================
-- 初期データ: デフォルト園
-- ============================================================
INSERT OR IGNORE INTO nurseries (id, name)
VALUES ('ayukko_001', '滋賀医科大学学内保育所 あゆっこ');
