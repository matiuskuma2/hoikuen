-- あゆっこ保育園 業務自動化システム
-- Migration: 0004_view_token.sql
-- Created: 2026-03-14
-- Purpose: 公開カレンダーURL保護用の閲覧トークン追加
--
-- view_token: 32文字のランダムhex。保護者に共有するURL用。
-- childId ではなく view_token をURLに含めることで、推測不可能にする。
-- URL例: /my/a1b2c3d4e5f6...  (32文字hex)
-- 既存の childId ベースのURLは view_token に移行後に廃止予定

ALTER TABLE children ADD COLUMN view_token TEXT;

-- 既存レコードに一括でトークンを付与
UPDATE children SET view_token = lower(hex(randomblob(16))) WHERE view_token IS NULL;

-- ユニークインデックス（トークンでの逆引き用）
CREATE UNIQUE INDEX IF NOT EXISTS idx_children_view_token ON children(view_token);
