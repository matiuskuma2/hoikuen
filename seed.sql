-- あゆっこ保育園 業務自動化システム
-- Seed data: テスト用データ
-- Created: 2026-02-16

-- ============================================================
-- 料金ルール (2025年度)
-- ============================================================
INSERT OR IGNORE INTO pricing_rules (id, nursery_id, fiscal_year, rules_json, source_file)
VALUES (
  'pr_2025',
  'ayukko_001',
  2025,
  '{
    "fiscal_year": 2025,
    "monthly_fees": {
      "0~2歳": { "1": 45000, "2": 50000, "3": 54000 },
      "3歳":   { "1": 36000, "2": 41000, "3": 45000 },
      "4~5歳": { "1": 35000, "2": 39000, "3": 42000 }
    },
    "spot_rates": {
      "0~2歳": 200,
      "3歳":   200,
      "4~5歳": 150
    },
    "early_morning_fee": 300,
    "extension_fee": 300,
    "night_fees": {
      "0~2歳": 3000,
      "3歳":   2500,
      "4~5歳": 2500
    },
    "sick_fee": 2500,
    "meal_prices": {
      "lunch": 300,
      "am_snack": 50,
      "pm_snack": 100,
      "dinner": 300
    },
    "time_boundaries": {
      "open": "07:30",
      "early_start": "07:00",
      "early_end": "07:30",
      "extension_start": "18:00",
      "night_start": "20:00",
      "close": "20:00"
    },
    "rounding": {
      "monthly": "15min",
      "spot": "30min"
    }
  }',
  '保育料案内.pdf'
);

-- ============================================================
-- テスト園児（Mondal Aum の例）
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

-- ============================================================
-- テスト用 追加園児
-- ============================================================
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
-- LINE連携 テスト用連携コード
-- ============================================================
INSERT OR IGNORE INTO link_codes (id, code, nursery_id, expires_at, created_at)
VALUES
  ('lc_test_001', 'AYK-0001', 'ayukko_001', '2027-12-31T23:59:59', datetime('now')),
  ('lc_test_002', 'AYK-0002', 'ayukko_001', '2027-12-31T23:59:59', datetime('now')),
  ('lc_test_003', 'AYK-1234', 'ayukko_001', '2027-12-31T23:59:59', datetime('now'));
