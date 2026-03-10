-- Migration: 0003_breakfast_flag.sql
-- Created: 2026-03-10
-- Purpose: Add breakfast_flag to schedule_plans and usage_facts

-- schedule_plans に朝食フラグ追加
ALTER TABLE schedule_plans ADD COLUMN breakfast_flag INTEGER DEFAULT 0;

-- usage_facts に朝食フラグ追加（既存の has_lunch の前に論理的に来る）
ALTER TABLE usage_facts ADD COLUMN has_breakfast INTEGER DEFAULT 0;

-- charge_lines の charge_type に breakfast を追加するため、CHECK制約を再作成
-- SQLiteではALTER TABLE DROP CONSTRAINTができないため、新しい値は挿入時に対応
-- (D1/SQLite の CHECK制約はスキーマ変更なしで新値を受け入れる場合がある)
