import { describe, expect, it } from 'vitest';
import { ceilDiv, closeEnough, firstInput, lamportsFor, priceUnits, rescale, spendCap } from '../src/sizing';

describe('price', () => {
  it('converts the float price to USDC base units', () => {
    expect(priceUnits(110.14651905455693)).toBe(110_146_519n);
    expect(priceUnits(1)).toBe(1_000_000n);
  });

  it('refuses a price that cannot be used', () => {
    for (const bad of [0, -5, NaN, Infinity]) expect(() => priceUnits(bad)).toThrow();
  });
});

describe('lamportsFor', () => {
  it('rounds up, so the estimate never undershoots', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    // $1 at $110.146519 per SOL
    expect(lamportsFor(1_000_000n, 110_146_519n)).toBe(9_078_817n);
    // $100 at exactly $100 per SOL is exactly 1 SOL
    expect(lamportsFor(100_000_000n, 100_000_000n)).toBe(1_000_000_000n);
  });
});

describe('spendCap', () => {
  it('is the price-implied amount plus the margin', () => {
    const price = 100_000_000n; // $100 per SOL
    expect(spendCap(100_000_000n, price, 300n)).toBe(1_030_000_000n);
    expect(spendCap(1_000_000n, price, 0n)).toBe(10_000_000n);
  });

  it('scales with the payment, so a small payment has a small cap', () => {
    const price = 110_000_000n;
    const small = spendCap(1_000_000n, price, 300n);
    const large = spendCap(100_000_000n, price, 300n);
    // A hundredth of the large cap, give or take the two round-ups.
    expect(small * 100n - large).toBeGreaterThanOrEqual(0n);
    expect(small * 100n - large).toBeLessThanOrEqual(200n);
  });
});

describe('ExactIn sizing', () => {
  // A pretend market: the order guarantees input * rate, less slippage, rounded down.
  const guaranteed = (input: bigint, price: bigint, slippageBps: bigint) =>
    (((input * price) / 1_000_000_000n) * (10_000n - slippageBps)) / 10_000n;

  it('starts above the price-implied input', () => {
    const price = 110_000_000n;
    expect(firstInput(23_500_000n, price, 60n)).toBeGreaterThan(lamportsFor(23_500_000n, price));
  });

  it('covers the target after one correction, across amounts, prices and slippage', () => {
    const targets = [10_000n, 1_000_000n, 23_500_000n, 99_990_000n, 100_000_000n];
    const prices = [18_300_000n, 110_146_519n, 262_771_234n];
    const slippages = [0n, 17n, 61n, 150n];
    for (const target of targets) {
      for (const price of prices) {
        for (const slip of slippages) {
          // The market sits 0.4% under the price feed, as a quote with fees would.
          const market = (price * 996n) / 1000n;
          let input = firstInput(target, price, 60n);
          let got = guaranteed(input, market, slip);
          if (!closeEnough(got, target)) {
            input = rescale(input, got, target, 5n);
            got = guaranteed(input, market, slip);
          }
          expect(got).toBeGreaterThanOrEqual(target);
          // and does not overshoot by more than 1% (plus a unit of rounding on tiny amounts)
          expect(got * 100n).toBeLessThanOrEqual(target * 101n + 100n);
        }
      }
    }
  });

  it('scales down as well as up', () => {
    // Guaranteed twice the target: halve the input (plus the pad).
    expect(rescale(1_000_000n, 2_000_000n, 1_000_000n, 0n)).toBe(500_000n);
    expect(rescale(1_000_000n, 500_000n, 1_000_000n, 0n)).toBe(2_000_000n);
    expect(rescale(1_000_000n, 1_000_000n, 1_000_000n, 5n)).toBe(1_000_500n);
  });

  it('will not scale from a quote that guarantees nothing', () => {
    expect(() => rescale(1n, 0n, 1n, 0n)).toThrow();
  });

  it('accepts a minimum between the target and 1% over', () => {
    expect(closeEnough(1_000_000n, 1_000_000n)).toBe(true);
    expect(closeEnough(1_010_000n, 1_000_000n)).toBe(true);
    expect(closeEnough(1_010_001n, 1_000_000n)).toBe(false);
    expect(closeEnough(999_999n, 1_000_000n)).toBe(false);
  });
});
