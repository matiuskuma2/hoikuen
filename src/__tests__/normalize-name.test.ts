/**
 * normalizeName ユニットテスト
 */
import { describe, it, expect } from 'vitest';
import { normalizeName } from '../lib/excel-parser';

describe('normalizeName', () => {
  it('全角スペース → 半角スペース', () => {
    expect(normalizeName('山田\u3000太郎')).toBe('山田 太郎');
  });

  it('全角英数 → 半角英数', () => {
    expect(normalizeName('ＡＢＣ')).toBe('ABC');
  });

  it('半角カタカナ → 全角カタカナ', () => {
    expect(normalizeName('ﾔﾏﾀﾞ ﾀﾛｳ')).toBe('ヤマダ タロウ');
  });

  it('半角カタカナ濁点結合', () => {
    expect(normalizeName('ﾀﾞ')).toBe('ダ');
    expect(normalizeName('ﾊﾞ')).toBe('バ');
  });

  it('連続スペースを1つに', () => {
    expect(normalizeName('山田  太郎')).toBe('山田 太郎');
  });

  it('前後スペースをトリム', () => {
    expect(normalizeName('  山田 太郎  ')).toBe('山田 太郎');
  });

  it('区切り記号をスペースに変換', () => {
    expect(normalizeName('山田・太郎')).toBe('山田 太郎');
    expect(normalizeName('山田＝太郎')).toBe('山田 太郎');
  });

  it('空文字 → 空文字', () => {
    expect(normalizeName('')).toBe('');
  });

  it('null-like → 空文字', () => {
    // @ts-ignore
    expect(normalizeName(null)).toBe('');
    // @ts-ignore
    expect(normalizeName(undefined)).toBe('');
  });
});
