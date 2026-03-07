-- あゆっこ保育園 業務自動化システム
-- Seed data: テスト／開発用（ローカル・staging専用）
-- ⚠️ 本番環境には適用しないこと
-- Created: 2026-03-07

-- ============================================================
-- 本番 seed を先に適用
-- ============================================================
-- 先に seed.sql を適用してください

-- ============================================================
-- テスト園児
-- ============================================================
INSERT OR IGNORE INTO children (id, nursery_id, lukumi_id, name, birth_date, age_class, enrollment_type, child_order, enrolled_at, collection_method)
VALUES (
  'child_mondal_aum',
  'ayukko_001',
  '1251212',
  'Mondal Aum',
  '2025-02-06',
  0,
  '月極',
  1,
  '2025-02-06',
  '口座振替'
);

INSERT OR IGNORE INTO children (id, nursery_id, lukumi_id, name, birth_date, age_class, enrollment_type, child_order, enrolled_at, collection_method)
VALUES (
  'child_tanaka_yui',
  'ayukko_001',
  '1251213',
  '田中 ゆい',
  '2023-05-15',
  2,
  '月極',
  1,
  '2025-04-01',
  '口座振替'
);

-- ============================================================
-- テスト用 LINE連携コード
-- ============================================================
INSERT OR IGNORE INTO link_codes (id, code, nursery_id, expires_at, created_at)
VALUES
  ('lc_test_001', 'AYK-0001', 'ayukko_001', '2027-12-31T23:59:59', datetime('now')),
  ('lc_test_002', 'AYK-0002', 'ayukko_001', '2027-12-31T23:59:59', datetime('now')),
  ('lc_test_003', 'AYK-1234', 'ayukko_001', '2027-12-31T23:59:59', datetime('now'));
