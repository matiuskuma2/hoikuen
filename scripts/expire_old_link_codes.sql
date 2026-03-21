-- あゆっこ保育園 業務自動化システム
-- Script: expire_old_link_codes.sql
-- Purpose: 旧形式の連携コード（link_code_children 未設定）を即座に期限切れにする
-- Run: wrangler d1 execute ayukko-production --remote --file=./scripts/expire_old_link_codes.sql
--
-- 背景:
--   旧MVPでは link_codes に園児指定がなく、verifyAndLinkCode() が
--   nursery 全園児を一括紐付けしていた（セキュリティ問題）。
--   migration 0006 で link_code_children テーブルを追加し、
--   verifyAndLinkCode() を修正済み。
--   ただし、旧形式のコードが DB に残っていると混乱の元になるため、
--   本番投入前に明示的に期限切れにする。
--
-- 安全性:
--   - 既に使用済み (used_by_line_account_id IS NOT NULL) のコードは対象外
--   - link_code_children に紐付きがあるコード（新形式）は対象外
--   - expires_at を過去日に設定するだけなので、既存データは削除しない

UPDATE link_codes 
SET expires_at = '2020-01-01T00:00:00Z'
WHERE id NOT IN (SELECT DISTINCT link_code_id FROM link_code_children)
  AND used_by_line_account_id IS NULL;
