-- Migration: 0005_charge_lines_breakfast.sql
-- Created: 2026-03-17
-- Purpose: Recreate charge_lines with breakfast charge_type in CHECK constraint
-- Prerequisite: charge_lines table must be empty (verified before migration)

-- Step 1: Drop old table (data is empty, safe to drop)
DROP TABLE IF EXISTS charge_lines;

-- Step 2: Recreate with breakfast in CHECK constraint
CREATE TABLE charge_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  charge_type TEXT NOT NULL CHECK(charge_type IN (
    'monthly_fee','spot_care','early_morning','extension',
    'night','sick','breakfast','lunch','am_snack','pm_snack','dinner'
  )),
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, charge_type)
);
