import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from '../src/base58';
import { fakeKey, forgeOrder, PROGRAMS, type Recipe } from '../src/dev/forge';
import { check, Refusal, type Expectation, type Order } from '../src/verify';

const fixture = (name: string): Order =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const TAKER = fakeKey(100);

/** A $25 ExactOut payment at roughly $110 per SOL. */
const good: Recipe = { taker: TAKER, mode: 'ExactOut', first: 25_000_000n, second: 227_000_000n, slippageBps: 30 };
const want: Expectation = { taker: TAKER, units: 25_000_000n, cap: 234_000_000n, mode: 'ExactOut' };

const refused = (recipe: Partial<Recipe>, expectation: Partial<Expectation> = {}, order: Partial<Order> = {}) =>
  expect(() => check(forgeOrder({ ...good, ...recipe }, order), { ...want, ...expectation })).toThrow(Refusal);

describe('real Jupiter responses captured from mainnet', () => {
  it('accepts an ExactOut order and reads exactly $1.00 out of it', () => {
    const order = fixture('exact-out');
    const result = check(order, { taker: order.taker!, units: 1_000_000n, cap: 9_200_000n, mode: 'ExactOut' });
    expect(result.delivers).toBe(1_000_000n);
    // quoted 9,077,742 lamports plus 46 bps slippage, rounded up
    expect(result.spends).toBe(9_119_500n);
    expect(result.spends - BigInt(order.otherAmountThreshold!)).toBeLessThanOrEqual(1n);
  });

  it('accepts an ExactOut order that also creates the wallet\'s own USDC account', () => {
    const order = fixture('exact-out-new-wallet');
    const result = check(order, { taker: order.taker!, units: 1_000_000n, cap: 9_400_000n, mode: 'ExactOut' });
    expect(result.delivers).toBe(1_000_000n);
  });

  it.each(['exact-in', 'exact-in-shared', 'exact-in-two-routes'])('accepts ExactIn order %s', (name) => {
    const order = fixture(name);
    const units = 1_090_000n;
    const result = check(order, { taker: order.taker!, units, cap: 10_000_000n, mode: 'ExactIn' });
    expect(result.spends).toBe(10_000_000n);
    // The minimum read from the transaction matches the one Jupiter reported.
    expect(result.delivers).toBe(BigInt(order.otherAmountThreshold!));
  });

  it('refuses a market-maker order, which needs a second signer', () => {
    const order = fixture('market-maker');
    expect(() => check(order, { taker: order.taker!, units: 1_000_000n, cap: 10_000_000n, mode: 'ExactIn' })).toThrow(
      /signer other than this wallet/,
    );
  });

  it('refuses a real order when more is expected than it delivers', () => {
    const order = fixture('exact-out');
    const base = { taker: order.taker!, cap: 9_200_000n, mode: 'ExactOut' as const };
    expect(() => check(order, { ...base, units: 1_000_001n })).toThrow(/less than the amount/);
  });

  it('refuses a real order that costs more than the cap', () => {
    const order = fixture('exact-out');
    const base = { taker: order.taker!, units: 1_000_000n, mode: 'ExactOut' as const };
    expect(() => check(order, { ...base, cap: 9_119_498n })).toThrow(/more SOL than the live price allows/);
  });

  it('refuses a real order presented to a different wallet', () => {
    const order = fixture('exact-out');
    expect(() => check(order, { taker: TAKER, units: 1_000_000n, cap: 9_200_000n, mode: 'ExactOut' })).toThrow(
      /different wallet/,
    );
    // Even if the JSON is edited to match, the transaction's signer still gives it away.
    expect(() =>
      check({ ...order, taker: TAKER }, { taker: TAKER, units: 1_000_000n, cap: 9_200_000n, mode: 'ExactOut' }),
    ).toThrow(/not the one signing/);
  });
});

describe('forged transactions that are fine', () => {
  it.each([
    ['ExactOut', false],
    ['ExactOut', true],
    ['ExactIn', false],
    ['ExactIn', true],
  ] as const)('accepts %s (shared accounts: %s)', (mode, shared) => {
    const recipe: Recipe =
      mode === 'ExactOut'
        ? { ...good, shared }
        : { taker: TAKER, mode, shared, first: 230_000_000n, second: 25_200_000n, slippageBps: 30 };
    const result = check(forgeOrder(recipe), { ...want, mode });
    expect(result.delivers).toBeGreaterThanOrEqual(want.units);
    expect(result.spends).toBeLessThanOrEqual(want.cap);
  });

  it('reads the hard bounds out of the swap instruction', () => {
    const out = check(forgeOrder(good), want);
    expect(out.delivers).toBe(25_000_000n);
    expect(out.spends).toBe(227_681_000n); // 227,000,000 * 1.003

    const recipe: Recipe = { taker: TAKER, mode: 'ExactIn', first: 230_000_000n, second: 25_200_000n, slippageBps: 30 };
    const into = check(forgeOrder(recipe), { ...want, mode: 'ExactIn' });
    expect(into.spends).toBe(230_000_000n);
    expect(into.delivers).toBe(25_124_400n); // 25,200,000 * 0.997
  });
});

describe('forged transactions that must be refused', () => {
  it('a different destination', () => refused({ destination: fakeKey(55) }));
  it('a destination hidden in a lookup table', () => refused({ hideDestination: true }));
  it('a second signer', () => refused({ signers: 2 }));
  it('a swap kind it cannot read', () => refused({ tag: 'e517cb977ae3ad2a' }));
  it('an ExactIn swap when ExactOut was asked for', () => refused({ tag: 'bb64facc31c4af14' }));
  it('less USDC than the amount', () => refused({ first: 24_999_999n }));
  it('a quoted input that slippage pushes past the cap', () => refused({ second: 233_500_000n }));
  it('more SOL wrapped than the cap', () => refused({ wrap: 500_000_000n }));
  it('SOL sent to an account the swap does not spend from', () => refused({ wrapTo: 3 }));
  it('an enormous priority fee', () => refused({ computeUnitPrice: 50_000_000n }));
  it('the wrapped-SOL account closed to someone else', () => refused({ closeTo: 3 }));
  it('a token account created for someone else', () => refused({ createFor: 3 }));

  it('an absurd slippage setting', () => {
    const recipe: Recipe = { taker: TAKER, mode: 'ExactIn', first: 230_000_000n, second: 25_200_000n, slippageBps: 9000 };
    expect(() => check(forgeOrder(recipe, { otherAmountThreshold: '25200000' }), { ...want, mode: 'ExactIn' })).toThrow(
      /could deliver less/,
    );
  });

  it('a token approval slipped in beside the swap', () =>
    refused({ extra: [{ program: PROGRAMS.token, accounts: [3, 1, 0], data: [4, 255, 255, 255, 255, 0, 0, 0, 0] }] }));

  it('a token transfer slipped in beside the swap', () =>
    refused({ extra: [{ program: PROGRAMS.token, accounts: [3, 1, 0], data: [3, 1, 0, 0, 0, 0, 0, 0, 0] }] }));

  it('a second SOL transfer, however small', () =>
    refused({ extra: [{ program: PROGRAMS.system, accounts: [0, 3], data: [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] }] }));

  it('a priority fee just over the limit', () => {
    // 140,000 compute units at 35,800 micro-lamports is 5,012 lamports; the limit is 5,000.
    refused({ computeUnitPrice: 35_800n });
    expect(check(forgeOrder({ ...good, computeUnitPrice: 35_700n }), want).delivers).toBe(25_000_000n);
  });

  it('a System instruction that is not a transfer', () =>
    refused({ extra: [{ program: PROGRAMS.system, accounts: [0, 3], data: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }] }));

  it('a program that is not on the list', () =>
    refused({ extra: [{ program: fakeKey(77), accounts: [0], data: [1, 2, 3] }] }));

  it('two swaps', () =>
    refused({ extra: [{ program: PROGRAMS.jupiter, accounts: [0, 1, 3, 9, 9, 7, 7, 2, 9, 6], data: [1] }] }));
});

describe('tampered quotes', () => {
  it('wrong tokens', () => {
    refused({}, {}, { inputMint: fakeKey(1) });
    refused({}, {}, { outputMint: fakeKey(1) });
  });
  it('no request id', () => refused({}, {}, { requestId: '' }));
  it('no transaction', () => refused({}, {}, { transaction: '' }));
  it('amounts that are not plain integers', () => {
    refused({}, {}, { otherAmountThreshold: '1e9' });
    refused({}, {}, { outAmount: '-5' });
    refused({}, {}, { outAmount: undefined });
  });
  it('a quoted output below the amount', () => refused({}, {}, { outAmount: '24999999' }));
  it('a limit above the cap', () => refused({}, {}, { otherAmountThreshold: '900000000' }));

  it('an amount over the hard cap, whatever the quote says', () => {
    const big: Recipe = { ...good, first: 100_010_000n, second: 910_000_000n };
    expect(() => check(forgeOrder(big), { ...want, units: 100_010_000n, cap: 999_000_000n })).toThrow(/limit/);
  });
  it('a zero amount', () => refused({}, { units: 0n }));

  it('a transaction with bytes missing or added', () => {
    const order = forgeOrder(good);
    const bytes = fromBase64(order.transaction!);
    const cut = toBase64(bytes.subarray(0, bytes.length - 3));
    const padded = toBase64(Uint8Array.from([...bytes, 0]));
    expect(() => check({ ...order, transaction: cut }, want)).toThrow(/could not be read/);
    expect(() => check({ ...order, transaction: padded }, want)).toThrow(/could not be read/);
    expect(() => check({ ...order, transaction: 'not base64 !!' }, want)).toThrow(/could not be read/);
  });

  it('a legacy transaction', () => {
    const order = forgeOrder(good);
    const bytes = fromBase64(order.transaction!);
    bytes[65] = 1; // overwrite the v0 marker
    expect(() => check({ ...order, transaction: toBase64(bytes) }, want)).toThrow(/could not be read/);
  });
});
