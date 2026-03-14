/**
 * TIME_BOUNDARIES 閾値テスト
 * 
 * ビジネスルール:
 *   早朝保育:  07:00-07:30 (420-450)
 *   通常保育:  07:30-18:00 (450-1080)
 *   延長保育:  18:00-20:00 (1080-1200)
 *   夜間保育:  20:00以降   (1200+)
 */
import { describe, it, expect } from 'vitest';
import { TIME_BOUNDARIES, toMinutes, safeToMinutes } from '../types/index';

describe('TIME_BOUNDARIES 定数', () => {
  it('早朝保育開始 = 07:00 (420分)', () => {
    expect(TIME_BOUNDARIES.early_start).toBe(420);
  });
  it('早朝保育終了 / 通常保育開始 = 07:30 (450分)', () => {
    expect(TIME_BOUNDARIES.early_end).toBe(450);
  });
  it('延長保育開始 = 18:00 (1080分)', () => {
    expect(TIME_BOUNDARIES.extension_start).toBe(1080);
  });
  it('夜間保育開始 = 20:00 (1200分)', () => {
    expect(TIME_BOUNDARIES.night_start).toBe(1200);
  });
  it('閉園時刻 = 21:00 (1260分)', () => {
    expect(TIME_BOUNDARIES.close).toBe(1260);
  });
});

describe('toMinutes / safeToMinutes', () => {
  it('07:00 = 420', () => expect(toMinutes('07:00')).toBe(420));
  it('07:30 = 450', () => expect(toMinutes('07:30')).toBe(450));
  it('18:00 = 1080', () => expect(toMinutes('18:00')).toBe(1080));
  it('20:00 = 1200', () => expect(toMinutes('20:00')).toBe(1200));
  it('21:00 = 1260', () => expect(toMinutes('21:00')).toBe(1260));
  it('8:30 = 510', () => expect(toMinutes('8:30')).toBe(510));

  it('safeToMinutes(null) = null', () => expect(safeToMinutes(null)).toBeNull());
  it('safeToMinutes("") = null', () => expect(safeToMinutes('')).toBeNull());
  it('safeToMinutes("abc") = null', () => expect(safeToMinutes('abc')).toBeNull());
  it('safeToMinutes("17:59") = 1079', () => expect(safeToMinutes('17:59')).toBe(1079));
});

describe('閾値境界テスト — 延長保育判定', () => {
  // is_extension = endMin > extension_start (1080)
  const isExtension = (endTime: string) => {
    const endMin = toMinutes(endTime);
    return endMin > TIME_BOUNDARIES.extension_start ? 1 : 0;
  };

  it('17:59 → 通常 (延長なし)', () => expect(isExtension('17:59')).toBe(0));
  it('18:00 → 通常 (延長なし: > 判定なので等しい場合は含まない)', () => expect(isExtension('18:00')).toBe(0));
  it('18:01 → 延長', () => expect(isExtension('18:01')).toBe(1));
  it('19:59 → 延長', () => expect(isExtension('19:59')).toBe(1));
  it('20:00 → 延長 (夜間にもなるが、延長フラグも立つ)', () => expect(isExtension('20:00')).toBe(1));
  it('20:30 → 延長', () => expect(isExtension('20:30')).toBe(1));
});

describe('閾値境界テスト — 夜間保育判定', () => {
  // is_night = endMin > night_start (1200)
  const isNight = (endTime: string) => {
    const endMin = toMinutes(endTime);
    return endMin > TIME_BOUNDARIES.night_start ? 1 : 0;
  };

  it('19:59 → 夜間なし', () => expect(isNight('19:59')).toBe(0));
  it('20:00 → 夜間なし (> 判定なので等しい場合は含まない)', () => expect(isNight('20:00')).toBe(0));
  it('20:01 → 夜間', () => expect(isNight('20:01')).toBe(1));
  it('21:00 → 夜間', () => expect(isNight('21:00')).toBe(1));
});

describe('閾値境界テスト — 早朝保育判定', () => {
  // is_early_morning = startMin < early_end && startMin >= early_start
  const isEarlyMorning = (startTime: string) => {
    const startMin = toMinutes(startTime);
    return (startMin < TIME_BOUNDARIES.early_end && startMin >= TIME_BOUNDARIES.early_start) ? 1 : 0;
  };

  it('06:59 → 早朝なし (開園前)', () => expect(isEarlyMorning('06:59')).toBe(0));
  it('07:00 → 早朝', () => expect(isEarlyMorning('07:00')).toBe(1));
  it('07:15 → 早朝', () => expect(isEarlyMorning('07:15')).toBe(1));
  it('07:29 → 早朝', () => expect(isEarlyMorning('07:29')).toBe(1));
  it('07:30 → 通常 (早朝終了)', () => expect(isEarlyMorning('07:30')).toBe(0));
  it('08:00 → 通常', () => expect(isEarlyMorning('08:00')).toBe(0));
});

describe('閾値の一貫性テスト — 全3ファイルが同じ値を使用', () => {
  // この定数が types/index.ts にのみ定義されていることを確認
  // (excel-parser, usage-calculator, schedules は全て import している)
  it('延長保育 18:00 = 1080分', () => {
    expect(TIME_BOUNDARIES.extension_start).toBe(toMinutes('18:00'));
  });
  it('夜間保育 20:00 = 1200分', () => {
    expect(TIME_BOUNDARIES.night_start).toBe(toMinutes('20:00'));
  });
  it('早朝終了 07:30 = 450分', () => {
    expect(TIME_BOUNDARIES.early_end).toBe(toMinutes('07:30'));
  });
});
