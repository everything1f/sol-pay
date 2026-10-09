// Jupiter's keyless HTTP API: the only network this page talks to.

import { JUPITER, MAX_PRIORITY_FEE, RECEIVER, SOL_MINT, USDC_MINT } from './config';
import type { Mode, Order } from './verify';

/** Jupiter could not be reached, or kept answering "too many requests". */
export class Unreachable extends Error {}

export interface Reply<T> {
  status: number;
  body: T | null;
}

export interface Execution {
  status?: 'Success' | 'Failed';
  signature?: string;
  code?: number;
  error?: string;
  totalInputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function call<T>(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<Reply<T>> {
  for (let attempt = 0; ; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(JUPITER + path, { ...init, signal: abort.signal });
    } catch {
      throw new Unreachable('No answer from Jupiter.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) {
      if (attempt === 2) throw new Unreachable('Jupiter is rate-limiting this connection.');
      // The keyless limit is counted per window; the header says when the window ends.
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      await wait(Math.min(Math.max(reset || 0, 400), 2500));
      continue;
    }
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  }
}

/** USD price of 1 SOL. */
export async function getPrice(): Promise<number> {
  const { body } = await call<Record<string, { usdPrice?: number }>>(`/price/v3?ids=${SOL_MINT}`, undefined, 6000);
  const price = body?.[SOL_MINT]?.usdPrice;
  if (typeof price !== 'number') throw new Unreachable('Jupiter returned no SOL price.');
  return price;
}

/**
 * A quote plus an unsigned SOL-to-USDC transaction that pays RECEIVER.
 * `amount` is USDC base units for ExactOut and lamports for ExactIn.
 * Only Jupiter's on-chain router is allowed: its transactions send the USDC
 * straight to RECEIVER and have a layout verify.ts can read.
 */
export function getOrder(taker: string, amount: bigint, mode: Mode): Promise<Reply<Order>> {
  const query = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: amount.toString(),
    swapMode: mode,
    taker,
    receiver: RECEIVER,
    excludeRouters: 'jupiterz,dflow,okx',
    // Jupiter picks the priority fee, but never above this.
    priorityFeeLamports: MAX_PRIORITY_FEE.toString(),
    broadcastFeeType: 'maxCap',
  });
  return call<Order>(`/swap/v2/order?${query}`, undefined, 8000);
}

/** Hands a signed transaction to Jupiter, which broadcasts it and waits for confirmation. */
export function execute(signedTransaction: string, requestId: string): Promise<Reply<Execution>> {
  return call<Execution>(
    '/swap/v2/execute',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction, requestId }),
    },
    45_000,
  );
}
