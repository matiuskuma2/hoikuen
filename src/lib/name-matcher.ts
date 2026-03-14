/**
 * Name Normalization & Matching Engine
 * 
 * Handles name variations across Lukumi, schedule plans, roster, billing
 * 
 * ⚠️ 懸念点: normalizeName は excel-parser.ts の完全版を正規の実装とし、
 * ここでは re-export する。二重実装による不一致リスクを排除。
 */

import type { Child } from '../types/index';
// 正規の normalizeName を excel-parser から import
import { normalizeName } from './excel-parser';

// re-export for backward compatibility
export { normalizeName };

export interface MatchResult {
  child: Child | null;
  confidence: number;
  method: string;
}

/**
 * Match a target name to a child in the roster
 * Priority: lukumi_id > exact name > surname-only (single candidate)
 */
export function matchChild(
  targetName: string,
  children: Child[],
  lukumiId?: string | null,
): MatchResult {

  const normalized = normalizeName(targetName);

  // 1. Lukumi ID match (highest priority)
  if (lukumiId) {
    const byId = children.find(c => c.lukumi_id === lukumiId);
    if (byId) {
      return { child: byId, confidence: 1.0, method: 'lukumi_id' };
    }
  }

  // 2. Exact normalized name match
  const exact = children.find(c => normalizeName(c.name) === normalized);
  if (exact) {
    return { child: exact, confidence: 1.0, method: 'exact_name' };
  }

  // 3. Surname-only match (if single candidate)
  const surname = normalized.split(' ')[0];
  if (surname) {
    const candidates = children.filter(c => normalizeName(c.name).startsWith(surname + ' '));
    if (candidates.length === 1) {
      return { child: candidates[0], confidence: 0.8, method: 'surname_only' };
    }
  }

  // 4. No match
  return { child: null, confidence: 0, method: 'unmatched' };
}

/**
 * Normalize time string to HH:MM format
 * Accepts: "8:30", "08:30", "8:30:00", "08:30:00"
 */
export function normalizeTime(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  if (!str) return null;

  // Handle Excel serial time (e.g., 0.354166...)
  const numVal = parseFloat(str);
  if (!isNaN(numVal) && numVal >= 0 && numVal < 1) {
    const totalMin = Math.round(numVal * 24 * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  }

  // Handle HH:MM or HH:MM:SS
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const h = parseInt(match[1], 10);
    const m = match[2];
    return `${h}:${m}`;
  }

  return null;
}
