// One payment, from quote to result. No DOM in here.

import { toBase64 } from './base58';
import { PRICE_MARGIN_BPS, WARM_QUOTE_MS } from './config';
import { execute, getOrder, type Execution, type Reply } from './jupiter';
import { closeEnough, firstInput, rescale, spendCap } from './sizing';
import { signatureOf } from './tx';
import { check, Refusal, type Checked, type Mode, type Order } from './verify';

/** The payment did not happen. The message is written for the screen. */
export class Failed extends Error {}

export interface Quote {
  taker: string;
  units: bigint;
  requestId: string;
  checked: Checked;
  at: number;
}

export type Phase = 'quoting' | 'awaiting' | 'sending';

interface Amounts {
  signature: string;
  usdc: bigint;
  lamports: bigint;
}
export type Outcome =
  /** Jupiter confirmed it on-chain. */
  | ({ kind: 'paid' } & Amounts)
  /** Phantom broadcast it; this page has no way to watch for confirmation. */
  | ({ kind: 'sent' } & Amounts)
  /** It was submitted but nobody confirmed the result. It may still land. */
  | ({ kind: 'unconfirmed' } & Amounts);

export interface Hands {
  taker: string;
  units: bigint;
  /** A recent SOL price in USDC base units. */
  price(): Promise<bigint>;
  /** A quote fetched while the amount was being typed, if any. */
  warm?: Promise<Quote>;
  phase(phase: Phase): void;
  /** Whether this Phantom can sign without sending. */
  canSign: boolean;
  sign(transaction: Uint8Array): Promise<Uint8Array>;
  signAndSend(transaction: Uint8Array): Promise<string>;
  /** True once Jupiter has refused a transaction signed by this Phantom. */
  sendOnly(): boolean;
  rememberSendOnly(): void;
  trace(line: string): void;
}

function usable({ status, body }: Reply<Order>): Order {
  if (!body || status >= 500) throw new Failed('Jupiter is having trouble. Nothing was sent.');
  if (status >= 400) throw new Failed(`Jupiter could not quote this (${body.error ?? status}). Nothing was sent.`);
  if (!body.transaction) {
    if (body.errorCode === 1) throw new Failed('Not enough SOL in this wallet.');
    if (body.errorCode === 2) throw new Failed('Not enough SOL to cover the network fee.');
    throw new Failed(`Jupiter returned no transaction (${body.errorMessage ?? body.error ?? 'no reason given'}).`);
  }
  return body;
}

/** Gets a quote whose transaction has passed every check in verify.ts. */
export async function quote(taker: string, units: bigint, price: bigint): Promise<Quote> {
  const cap = spendCap(units, price, PRICE_MARGIN_BPS);
  const checked = (order: Order, mode: Mode): Quote => ({
    taker,
    units,
    requestId: order.requestId ?? '',
    checked: check(order, { taker, units, cap, mode }),
    at: Date.now(),
  });

  // Ask for exactly `units` out. Jupiter's reference lists ExactIn only, though the
  // endpoint honours ExactOut; if that ever stops, fall through to sizing the input.
  const exactOut = async (): Promise<Quote | undefined> => {
    const reply = await getOrder(taker, units, 'ExactOut');
    if (reply.status >= 400 || reply.body?.swapMode !== 'ExactOut') return undefined;
    return checked(usable(reply), 'ExactOut');
  };

  // Choose an input whose guaranteed minimum output covers `units`, correcting once.
  const exactIn = async (): Promise<Quote> => {
    let input = firstInput(units, price, 60n);
    for (let round = 0; ; round++) {
      const order = usable(await getOrder(taker, input, 'ExactIn'));
      const text = order.otherAmountThreshold ?? '';
      const guaranteed = /^\d+$/.test(text) ? BigInt(text) : 0n;
      if (guaranteed <= 0n) throw new Failed('Jupiter returned a quote with no guaranteed amount.');
      if (round === 1 || closeEnough(guaranteed, units)) return checked(order, 'ExactIn');
      input = rescale(input, guaranteed, units, 5n);
    }
  };

  // A transaction that fails the checks earns one fresh quote before the refusal is shown.
  try {
    return (await exactOut()) ?? (await exactIn());
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
  }
  return (await exactOut()) ?? (await exactIn());
}

// /execute result codes, grouped by what they say about the transaction's fate.
/** Never broadcast: the quote had gone stale. Quoting again cannot pay twice. */
const STALE = new Set([-1, -1004, -2003]);
/** Never broadcast: Jupiter would not take the signed copy Phantom returned. */
const UNACCEPTED = new Set([-2, -3, -1003]);
/** Never broadcast: Jupiter judged the transaction invalid. */
const INVALID = new Set([-1002, -2002, -2004]);

const digits = (text: string | undefined): bigint | undefined =>
  text && /^\d+$/.test(text) ? BigInt(text) : undefined;

const sameMessage = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.subarray(65).every((byte, i) => byte === b[65 + i]);

export async function pay(h: Hands): Promise<Outcome> {
  let warm = h.warm;

  for (let attempt = 0; ; attempt++) {
    h.phase('quoting');
    const ready = await warm?.catch(() => undefined);
    warm = undefined;
    const fresh = ready && ready.taker === h.taker && ready.units === h.units && Date.now() - ready.at < WARM_QUOTE_MS;
    const q = fresh ? ready : await quote(h.taker, h.units, await h.price());
    const { bytes, delivers, spends } = q.checked;
    h.trace(`quote ${fresh ? '(warm) ' : ''}delivers ${delivers} spends up to ${spends}`);

    h.phase('awaiting');
    if (!h.canSign || h.sendOnly()) {
      const signature = await h.signAndSend(bytes);
      h.trace('Phantom signed and sent');
      return { kind: 'sent', signature, usdc: delivers, lamports: spends };
    }

    const signed = await h.sign(bytes);
    h.trace(sameMessage(bytes, signed) ? 'Phantom signed it unchanged' : 'Phantom changed the transaction while signing');
    const amounts = { signature: signatureOf(signed), usdc: delivers, lamports: spends };

    h.phase('sending');
    const payload = toBase64(signed);
    let reply: Reply<Execution>;
    let resent = false;
    try {
      reply = await execute(payload, q.requestId);
    } catch {
      // The request may have arrived all the same. Sending the identical signed
      // transaction again cannot pay twice.
      resent = true;
      try {
        reply = await execute(payload, q.requestId);
      } catch {
        return { kind: 'unconfirmed', ...amounts };
      }
    }

    const result = reply.body ?? {};
    const code = result.code;
    h.trace(`execute http ${reply.status} status ${result.status} code ${code} ${result.error ?? ''}`);

    if (result.status === 'Success') {
      const out = digits(result.outputAmountResult);
      const spent = digits(result.totalInputAmount);
      return {
        kind: 'paid',
        signature: amounts.signature,
        usdc: out !== undefined && out >= delivers ? out : delivers,
        lamports: spent !== undefined && spent > 0n && spent <= spends ? spent : spends,
      };
    }

    // After a lost request, only "Success" is trustworthy: the first copy may have landed.
    if (resent || code === undefined) return { kind: 'unconfirmed', ...amounts };

    if (STALE.has(code)) {
      if (attempt === 0) continue;
      throw new Failed('The quote expired twice before it could be sent. Nothing was sent.');
    }
    if (UNACCEPTED.has(code) && attempt === 0) {
      h.rememberSendOnly();
      continue;
    }
    if (UNACCEPTED.has(code) || INVALID.has(code)) {
      throw new Failed(`Jupiter rejected the transaction (code ${code}). Nothing was sent.`);
    }
    // A program error means it landed and failed, which moves no money.
    if (code > 0) throw new Failed(`The swap failed on-chain (code ${code}). Nothing was delivered.`);

    // Anything else, such as "failed to land", leaves the outcome open.
    return { kind: 'unconfirmed', ...amounts };
  }
}
