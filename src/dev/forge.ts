// Development and tests only. Builds transactions shaped like the ones Jupiter's
// on-chain router returns, plus deliberately wrong ones for testing the safety checks.
// Nothing here is imported by the production page.

import { b58decode, b58encode, toBase64 } from '../base58';
import { RECEIVER_USDC_ACCOUNT, SOL_MINT, USDC_MINT } from '../config';
import type { Mode, Order } from '../verify';

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  budget: 'ComputeBudget111111111111111111111111111111',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenAccounts: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
};

const TAGS: Record<string, string> = {
  'ExactOut': '9d8ab85215f4f324',
  'ExactOut shared': '3560e5cad8bbfa18',
  'ExactIn': 'bb64facc31c4af14',
  'ExactIn shared': 'd19853937cfed8e9',
};

/** A made-up but well-formed address. */
export const fakeKey = (seed: number): string =>
  b58encode(Uint8Array.from({ length: 32 }, (_, i) => (seed * 37 + i * 11 + 5) & 255));

export interface ExtraInstruction {
  program: string;
  accounts: number[];
  data: number[];
}

export interface Recipe {
  taker: string;
  mode: Mode;
  /** ExactOut: USDC delivered. ExactIn: lamports spent. */
  first: bigint;
  /** ExactOut: quoted lamports in. ExactIn: quoted USDC out. */
  second: bigint;
  slippageBps?: number;
  shared?: boolean;

  // Knobs for forging transactions that must be refused.
  /** Where the swap sends its output. Defaults to the Coinbase USDC account. */
  destination?: string;
  /** Reach the destination through a lookup table instead of naming it. */
  hideDestination?: boolean;
  /** Lamports wrapped before the swap. */
  wrap?: bigint;
  /** Where the wrapped SOL goes (account index). */
  wrapTo?: number;
  signers?: number;
  tag?: string;
  computeUnitPrice?: bigint;
  /** Who receives the closed wrapped-SOL account's balance (account index). */
  closeTo?: number;
  /** Owner of the token account created up front (account index). */
  createFor?: number;
  extra?: ExtraInstruction[];
}

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n));
const bytesOf = (hexText: string) => (hexText.match(/../g) ?? []).map((h) => parseInt(h, 16));
const compact = (n: number) => (n < 128 ? [n] : [(n & 127) | 128, n >> 7]);

/** The unsigned transaction bytes for a recipe. */
export function forgeTransaction(r: Recipe): Uint8Array {
  const slippage = r.slippageBps ?? 30;
  const extraPrograms = [...new Set((r.extra ?? []).map((x) => x.program))].filter(
    (p) => !Object.values(PROGRAMS).includes(p),
  );

  const writable = [
    r.taker, // 0: fee payer and signer
    fakeKey(1), // 1: temporary wrapped-SOL account
    ...(r.hideDestination ? [] : [r.destination ?? RECEIVER_USDC_ACCOUNT]), // 2: where the USDC goes
    fakeKey(3), // the wallet's own USDC account, named by the swap but never credited
  ];
  const readonly = [
    PROGRAMS.system,
    PROGRAMS.budget,
    PROGRAMS.jupiter,
    PROGRAMS.token,
    PROGRAMS.tokenAccounts,
    ...extraPrograms,
  ];
  const keys = [...writable, ...readonly];
  const at = (key: string) => keys.indexOf(key);
  const own = at(fakeKey(3));

  // One lookup table: three writable addresses, then four read-only ones.
  const loaded = (n: number) => keys.length + n;
  const [pool, poolIn, poolOut] = [loaded(0), loaded(1), loaded(2)];
  const [solMint, usdcMint, eventAuthority, programAuthority] = [loaded(3), loaded(4), loaded(5), loaded(6)];
  const destination = r.hideDestination ? pool : 2;

  const token = at(PROGRAMS.token);
  const amounts = [...u64(r.first), ...u64(r.second), ...u16(slippage), ...u16(0), ...u16(0)];
  const route = [1, 0, 0, 0, 0x11, 1, 0, 0x10, 0x27, 0, 1];
  const tag = bytesOf(r.tag ?? TAGS[r.shared ? `${r.mode} shared` : r.mode]);

  const defaultWrap = r.mode === 'ExactOut' ? (r.second * BigInt(10_000 + slippage + 4)) / 10_000n : r.first;

  const instructions: ExtraInstruction[] = [
    { program: PROGRAMS.budget, accounts: [], data: [2, ...u32(140_000)] },
    { program: PROGRAMS.budget, accounts: [], data: [3, ...u64(r.computeUnitPrice ?? 2_500n)] },
    {
      program: PROGRAMS.tokenAccounts,
      accounts: [0, 1, r.createFor ?? 0, solMint, at(PROGRAMS.system), token],
      data: [1],
    },
    { program: PROGRAMS.system, accounts: [0, r.wrapTo ?? 1], data: [...u32(2), ...u64(r.wrap ?? defaultWrap)] },
    { program: PROGRAMS.token, accounts: [1], data: [17] },
    r.shared
      ? {
          program: PROGRAMS.jupiter,
          accounts: [programAuthority, 0, 1, poolIn, poolOut, destination, solMint, usdcMint, token, token, eventAuthority, at(PROGRAMS.jupiter), pool],
          data: [...tag, 7, ...amounts, ...route],
        }
      : {
          program: PROGRAMS.jupiter,
          accounts: [0, 1, own, solMint, usdcMint, token, token, destination, eventAuthority, at(PROGRAMS.jupiter), pool, poolIn, poolOut],
          data: [...tag, ...amounts, ...route],
        },
    ...(r.extra ?? []),
    { program: PROGRAMS.token, accounts: [1, r.closeTo ?? 0, 0], data: [9] },
  ];

  const signers = r.signers ?? 1;
  const out: number[] = [signers, ...new Array(64 * signers).fill(0)];
  out.push(0x80, signers, 0, readonly.length);
  out.push(...compact(keys.length), ...keys.flatMap((k) => [...b58decode(k)]));
  out.push(...new Array(32).fill(9)); // blockhash
  out.push(...compact(instructions.length));
  for (const ix of instructions) {
    out.push(at(ix.program), ...compact(ix.accounts.length), ...ix.accounts, ...compact(ix.data.length), ...ix.data);
  }
  out.push(1, ...b58decode(fakeKey(8)), 3, 10, 11, 12, 4, 20, 21, 22, 23);
  return Uint8Array.from(out);
}

/** A complete /order response for a recipe, the way Jupiter would describe it. */
export function forgeOrder(r: Recipe, overrides: Partial<Order> = {}): Order {
  const slippage = BigInt(r.slippageBps ?? 30);
  const limit =
    r.mode === 'ExactOut' ? (r.second * (10_000n + slippage)) / 10_000n : (r.second * (10_000n - slippage)) / 10_000n;
  return {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount: String(r.mode === 'ExactOut' ? r.second : r.first),
    outAmount: String(r.mode === 'ExactOut' ? r.first : r.second),
    otherAmountThreshold: String(limit),
    swapMode: r.mode,
    taker: r.taker,
    requestId: 'forged-request',
    transaction: toBase64(forgeTransaction(r)),
    ...overrides,
  };
}
