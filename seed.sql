-- あゆっこ保育園 業務自動化システム
-- Seed data: 本番用 初期データ（料金ルール・園マスタ）
-- Created: 2026-02-16
-- Updated: 2026-03-07

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
