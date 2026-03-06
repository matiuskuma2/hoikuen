-- あゆっこ保育園 業務自動化システム
-- Migration: 0002_line_integration.sql
-- Created: 2026-03-06
-- Purpose: LINE連携に必要なテーブル追加（Phase 1 MVP）

-- ============================================================
-- LINE アカウント連携
-- ============================================================
CREATE TABLE IF NOT EXISTS line_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  nursery_id TEXT NOT NULL DEFAULT 'ayukko_001' REFERENCES nurseries(id),
  linked_at TEXT DEFAULT (datetime('now')),
  unlinked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- LINE アカウント ↔ 児童 紐づけ（1保護者 → 複数児童対応）
-- ============================================================
CREATE TABLE IF NOT EXISTS line_account_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(line_account_id, child_id)
);

-- ============================================================
-- 連携コード（園側が発行 → 保護者がLINEで入力）
-- ============================================================
CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  code TEXT NOT NULL UNIQUE,
  nursery_id TEXT NOT NULL DEFAULT 'ayukko_001' REFERENCES nurseries(id),
  used_by_line_account_id TEXT REFERENCES line_accounts(id),
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- 会話状態（1ユーザー1行。状態機械の現在状態を保持）
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'IDLE',
  current_child_id TEXT REFERENCES children(id),
  current_year INTEGER,
  current_month INTEGER,
  draft_entries TEXT DEFAULT '[]',
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- 会話ログ（監査用・デバッグ用）
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL,
  message_text TEXT,
  state_before TEXT,
  state_after TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_logs_user ON conversation_logs(line_user_id, created_at);

-- ============================================================
-- 変更リクエスト（前日17時以降の変更記録）
-- ============================================================
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('absence', 'time_change', 'meal_cancel', 'add_day')),
  original_start TEXT,
  original_end TEXT,
  requested_start TEXT,
  requested_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  requested_by TEXT NOT NULL,
  requested_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_requests_child_date
  ON schedule_change_requests(child_id, year, month, day);
