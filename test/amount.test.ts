import { describe, expect, it } from 'vitest';
import { formatSol, formatUnits, formatUsdc, press, toUnits, type Key } from '../src/amount';

const MAX = 100_000_000n; // $100

/** Types a sequence on the keypad; "<" is backspace. */
function type(keys: string, start = ''): string {
  let value = start;
  for (const k of keys) value = press(value, (k === '<' ? 'back' : k) as Key, MAX).value;
  return value;
}

describe('keypad', () => {
  it('builds an amount digit by digit', () => {
    expect(type('23.50')).toBe('23.50');
    expect(type('7')).toBe('7');
  });

  it('turns a leading point into "0."', () => {
    expect(type('.5')).toBe('0.5');
    expect(type('.')).toBe('0.');
  });

  it('drops leading zeros', () => {
    expect(type('007')).toBe('7');
    expect(type('0.07')).toBe('0.07');
    expect(type('00.5')).toBe('0.5');
  });

  it('allows one decimal point', () => {
    expect(press('1.5', '.', MAX)).toEqual({ value: '1.5', rejected: 'dot' });
    expect(press('1.', '.', MAX)).toEqual({ value: '1.', rejected: 'dot' });
  });

  it('allows at most two decimals', () => {
    expect(type('1.234')).toBe('1.23');
    expect(press('1.23', '4', MAX)).toEqual({ value: '1.23', rejected: 'decimals' });
  });

  it('refuses a digit that would pass the cap', () => {
    expect(type('100')).toBe('100');
    expect(type('100.00')).toBe('100.00');
    expect(press('100', '0', MAX)).toEqual({ value: '100', rejected: 'max' });
    expect(press('100.0', '1', MAX)).toEqual({ value: '100.0', rejected: 'max' });
    expect(press('99', '9', MAX)).toEqual({ value: '99', rejected: 'max' });
    expect(type('99.99')).toBe('99.99');
  });

  it('backspaces one character and reports an empty field', () => {
    expect(type('23.5<')).toBe('23.');
    expect(type('23.5<<')).toBe('23');
    expect(type('5<')).toBe('');
    expect(press('', 'back', MAX)).toEqual({ value: '', rejected: 'empty' });
  });
});

describe('toUnits', () => {
  it('converts to USDC base units exactly', () => {
    expect(toUnits('')).toBe(0n);
    expect(toUnits('0')).toBe(0n);
    expect(toUnits('0.')).toBe(0n);
    expect(toUnits('0.01')).toBe(10_000n);
    expect(toUnits('0.5')).toBe(500_000n);
    expect(toUnits('23.50')).toBe(23_500_000n);
    expect(toUnits('100')).toBe(100_000_000n);
  });

  it('has no float error on amounts floats get wrong', () => {
    expect(toUnits('0.07')).toBe(70_000n); // 0.07 * 1e6 is 70000.00000000001 in floats
    expect(toUnits('19.99')).toBe(19_990_000n); // 19.99 * 100 is 1998.9999999999998
    expect(toUnits('4.35')).toBe(4_350_000n);
  });

  it('round-trips every cent from 0.01 to 100.00', () => {
    for (let cents = 1; cents <= 10_000; cents++) {
      const text = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
      expect(toUnits(text)).toBe(BigInt(cents) * 10_000n);
    }
  });

  it('rejects anything the keypad cannot produce', () => {
    for (const bad of ['1.234', '1..2', '-1', '1e3', 'abc', '1,50', ' 1']) {
      expect(() => toUnits(bad)).toThrow();
    }
  });
});

describe('formatting', () => {
  it('shows USDC with at least two decimals and no rounding up', () => {
    expect(formatUsdc(23_500_000n)).toBe('23.50');
    expect(formatUsdc(1_000_000n)).toBe('1.00');
    expect(formatUsdc(1_097_993n)).toBe('1.097993');
    expect(formatUsdc(10_000n)).toBe('0.01');
    expect(formatUsdc(0n)).toBe('0.00');
  });

  it('truncates SOL to the places asked for', () => {
    expect(formatSol(213_456_789n)).toBe('0.2134');
    expect(formatSol(9_077_742n, 6)).toBe('0.009077');
    expect(formatSol(1_999_999_999n)).toBe('1.9999');
    expect(formatSol(5n)).toBe('0.0000');
  });

  it('formats whole numbers when no decimals are wanted', () => {
    expect(formatUnits(5_000_000n, 6, 0)).toBe('5');
  });
});
