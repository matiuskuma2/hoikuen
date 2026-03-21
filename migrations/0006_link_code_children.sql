-- あゆっこ保育園 業務自動化システム
-- Migration: 0006_link_code_children.sql
-- Created: 2026-03-21
-- Purpose: 連携コードと園児の個別紐付け（全園児一括紐付けのMVP実装を修正）
--
-- 問題: verifyAndLinkCode() が link_code 1つで nursery 全園児に紐づけていた
-- 解決: link_code_children テーブルで「このコードはこの園児用」を明示管理
--
-- 運用:
--   1. 職員が管理画面で連携コード発行時に対象園児を選択
--   2. link_code_children に (link_code_id, child_id) を記録
--   3. 保護者がコード入力 → 指定された園児のみ line_account_children に紐付け

-- ============================================================
-- 連携コード ↔ 園児 紐づけ（1コード → 1〜N園児）
-- ============================================================
CREATE TABLE IF NOT EXISTS link_code_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  link_code_id TEXT NOT NULL REFERENCES link_codes(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(link_code_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_link_code_children_code ON link_code_children(link_code_id);
CREATE INDEX IF NOT EXISTS idx_link_code_children_child ON link_code_children(child_id);
