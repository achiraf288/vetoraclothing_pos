import { describe, expect, it } from 'vitest';
import { allocateProportionally, formatMoney, MoneyError, parseMoney, percentOfMinor } from '../electron/db/money';

describe('money', () => {
  it('parses decimal text into integer minor units without float error', () => {
    expect(parseMoney('0.10')).toBe(10);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('1,250.50')).toBe(125050);
    expect(parseMoney('19.99')).toBe(1999);
    expect(parseMoney('1250')).toBe(125000);
    expect(parseMoney('100', 0)).toBe(100);
    expect(parseMoney('2.675', 3)).toBe(2675);
  });

  it('rejects malformed amounts and excess precision', () => {
    expect(() => parseMoney('abc')).toThrow(MoneyError);
    expect(() => parseMoney('1.234')).toThrow(/decimal place/);
    expect(() => parseMoney('')).toThrow(MoneyError);
    expect(() => parseMoney('1e5')).toThrow(MoneyError);
    expect(() => parseMoney('1.2.3')).toThrow(MoneyError);
  });

  it('formats minor units with grouping and currency symbol', () => {
    expect(formatMoney(125050, { symbol: 'Rs' })).toBe('Rs 1,250.50');
    expect(formatMoney(5, { symbol: 'Rs' })).toBe('Rs 0.05');
    expect(formatMoney(-2500)).toBe('-25.00');
    expect(formatMoney(1500, { decimals: 0 })).toBe('1,500');
  });

  it('rounds percentages half away from zero using integers only', () => {
    expect(percentOfMinor(10000, 1000)).toBe(1000); // 10%
    expect(percentOfMinor(1005, 1000)).toBe(101); // 100.5 -> 101
    expect(percentOfMinor(1004, 1000)).toBe(100);
    expect(percentOfMinor(0, 1500)).toBe(0);
    expect(percentOfMinor(-1005, 1000)).toBe(-101);
  });

  it('allocates a discount across lines so the parts always sum exactly', () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocateProportionally(1000, [2500, 7500])).toEqual([250, 750]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(7, [0, 10])).toEqual([0, 7]);
    for (let total = 0; total < 200; total += 7) {
      const w = [333, 1250, 999, 1];
      expect(allocateProportionally(total, w).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('refuses to allocate a non-zero total across zero weight', () => {
    expect(() => allocateProportionally(5, [0, 0])).toThrow(MoneyError);
  });
});
