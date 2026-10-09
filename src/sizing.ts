// Integer arithmetic for turning a USDC target into SOL amounts and limits.
// USDC is in base units (6 decimals), SOL in lamports (9 decimals).

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The API's float price of 1 SOL, as USDC base units. The only float in the money path. */
export function priceUnits(usdPerSol: number): bigint {
  if (!Number.isFinite(usdPerSol) || usdPerSol <= 0) throw new Error('no usable SOL price');
  return BigInt(Math.round(usdPerSol * 1e6));
}

/** Lamports worth `units` of USDC at `price`, rounded up. */
export function lamportsFor(units: bigint, price: bigint): bigint {
  return ceilDiv(units * LAMPORTS_PER_SOL, price);
}

/** The most SOL a payment of `units` may take: what the price implies, plus a margin. */
export function spendCap(units: bigint, price: bigint, marginBps: bigint): bigint {
  return ceilDiv(lamportsFor(units, price) * (BPS + marginBps), BPS);
}

// The rest is the ExactIn fallback: choose an input whose guaranteed minimum output covers the target.

/** First guess: the price-implied input plus a buffer for slippage and fees. */
export function firstInput(units: bigint, price: bigint, bufferBps: bigint): bigint {
  return ceilDiv(lamportsFor(units, price) * (BPS + bufferBps), BPS);
}

/** Second guess, scaled from what the first order actually guaranteed. */
export function rescale(input: bigint, guaranteed: bigint, units: bigint, padBps: bigint): bigint {
  if (guaranteed <= 0n) throw new Error('order guarantees nothing');
  return ceilDiv(input * units * (BPS + padBps), guaranteed * BPS);
}

/** Is a guaranteed minimum at least the target and no more than 1% over it? */
export function closeEnough(guaranteed: bigint, units: bigint): boolean {
  return guaranteed >= units && guaranteed * 100n <= units * 101n;
}
