// The safety checks. Nothing reaches Phantom unless check() returns.
//
// The quote's JSON is checked first, then the transaction itself is decoded and
// held to a whitelist, because the transaction is what actually gets signed.

import {
  MAX_PRIORITY_FEE,
  MAX_UNITS,
  MAX_USD,
  RECEIVER,
  RECEIVER_USDC_ACCOUNT,
  SOL_MINT,
  USDC_MINT,
} from './config';
import { fromBase64 } from './base58';
import { ceilDiv } from './sizing';
import { decodeTransaction, hex, u16, u32, u64, type Instruction, type Transaction } from './tx';

/** A check failed. The message says which, in words fit for the screen. */
export class Refusal extends Error {}

function refuse(why: string): never {
  throw new Refusal(why);
}

export type Mode = 'ExactOut' | 'ExactIn';

/** The fields of Jupiter's /order response that this page reads. */
export interface Order {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  taker?: string | null;
  transaction?: string | null;
  requestId?: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

export interface Expectation {
  /** The connected wallet. */
  taker: string;
  /** USDC base units Coinbase must receive. */
  units: bigint;
  /** Most lamports the payment may take. */
  cap: bigint;
  mode: Mode;
}

export interface Checked {
  /** The unsigned transaction, ready for the wallet. */
  bytes: Uint8Array;
  /** The least USDC the transaction can deliver without failing. */
  delivers: bigint;
  /** The most SOL the swap can take without failing. */
  spends: bigint;
}

const PROGRAM = {
  budget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenAccounts: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  jupiter: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
};

// The Jupiter swap instructions this page can read, keyed by their 8-byte tag.
// Layouts come from the program's on-chain IDL. `shared` variants carry a one-byte
// id before the amounts and order their accounts differently.
const SWAPS: Record<string, { mode: Mode; shared: boolean }> = {
  '9d8ab85215f4f324': { mode: 'ExactOut', shared: false }, // exact_out_route_v2
  '3560e5cad8bbfa18': { mode: 'ExactOut', shared: true }, // shared_accounts_exact_out_route_v2
  bb64facc31c4af14: { mode: 'ExactIn', shared: false }, // route_v2
  d19853937cfed8e9: { mode: 'ExactIn', shared: true }, // shared_accounts_route_v2
};

const BPS = 10_000n;
const DEFAULT_COMPUTE_UNITS = 1_400_000;

function amount(text: string | undefined, name: string): bigint {
  if (typeof text !== 'string' || !/^\d+$/.test(text)) refuse(`the quote's ${name} is missing`);
  return BigInt(text);
}

export function check(order: Order, want: Expectation): Checked {
  const { taker, units, cap, mode } = want;

  if (units <= 0n || units > MAX_UNITS) refuse(`the amount is outside the $${MAX_USD} limit`);
  if (order.inputMint !== SOL_MINT) refuse('the quote does not sell SOL');
  if (order.outputMint !== USDC_MINT) refuse('the quote does not buy USDC');
  if (order.taker !== taker) refuse('the quote was made for a different wallet');
  if (order.swapMode !== mode) refuse(`the quote is not ${mode}`);
  if (!order.requestId) refuse('the quote has no request id');

  const threshold = amount(order.otherAmountThreshold, 'limit');
  if (mode === 'ExactOut') {
    if (amount(order.outAmount, 'output') < units) refuse('the quote delivers less than the amount');
    if (threshold > cap) refuse('the quote costs more SOL than the live price allows');
  } else {
    if (threshold < units) refuse('the quote guarantees less than the amount');
    if (amount(order.inAmount, 'input') > cap) refuse('the quote costs more SOL than the live price allows');
  }

  if (!order.transaction) refuse('the quote came without a transaction');
  let bytes: Uint8Array;
  let tx: Transaction;
  try {
    bytes = fromBase64(order.transaction);
    tx = decodeTransaction(bytes);
  } catch {
    refuse('the transaction could not be read');
  }

  return { bytes, ...inspect(tx, want) };
}

function inspect(tx: Transaction, { taker, units, cap, mode }: Expectation) {
  // This wallet pays the fee and is the only signer.
  if (tx.signers !== 1 || tx.signatures.length !== 1 || tx.readonlySigned !== 0) {
    refuse('the transaction needs a signer other than this wallet');
  }
  if (tx.keys[0] !== taker) refuse('this wallet is not the one signing the transaction');

  // The Coinbase USDC account is named in the transaction itself (not hidden in a
  // lookup table) and is writable.
  const firstReadonly = tx.keys.length - tx.readonlyUnsigned;
  const coinbase = tx.keys.indexOf(RECEIVER_USDC_ACCOUNT);
  if (coinbase < 1 || coinbase >= firstReadonly) {
    refuse('the transaction does not pay the Coinbase USDC account');
  }

  let swap: Instruction | undefined;
  const transfers: { to: number; lamports: bigint }[] = [];
  let computeUnits = DEFAULT_COMPUTE_UNITS;
  let microLamportsPerUnit = 0n;
  let accountsCreated = 0;

  for (const ix of tx.instructions) {
    const d = ix.data;
    const a = ix.accounts;
    // A program reached through a lookup table has no entry in keys and falls to default.
    switch (tx.keys[ix.program]) {
      case PROGRAM.budget:
        if (d.length === 5 && d[0] === 2) computeUnits = u32(d, 1);
        else if (d.length === 9 && d[0] === 3) microLamportsPerUnit = u64(d, 1);
        else if (!(d.length === 5 && (d[0] === 1 || d[0] === 4))) {
          refuse('the transaction has an unknown compute budget instruction');
        }
        break;

      case PROGRAM.system:
        // Only plain transfers out of this wallet. Where they go is judged below, once
        // the swap says which account it spends from.
        if (d.length !== 12 || u32(d, 0) !== 2 || a.length !== 2 || a[0] !== 0) {
          refuse('the transaction has an unexpected System instruction');
        }
        transfers.push({ to: a[1], lamports: u64(d, 4) });
        break;

      case PROGRAM.tokenAccounts: {
        // Create or create-if-missing. Accounts: payer, new account, its owner, mint, …
        const create = d.length === 0 || (d.length === 1 && d[0] <= 1);
        const owner = tx.keys[a[2]];
        const mine = owner === taker;
        const coinbases = owner === RECEIVER && a[1] === coinbase;
        if (!create || a.length < 6 || a[0] !== 0 || !(mine || coinbases) || ++accountsCreated > 3) {
          refuse('the transaction has an unexpected token-account instruction');
        }
        break;
      }

      case PROGRAM.token: {
        const syncWrapped = d.length === 1 && d[0] === 17 && a.length === 1;
        // Closing the temporary wrapped-SOL account, with the leftover returning to this wallet.
        const closeToSelf =
          d.length === 1 && d[0] === 9 && a.length === 3 && a[0] !== coinbase && a[1] === 0 && a[2] === 0;
        if (!syncWrapped && !closeToSelf) refuse('the transaction has an unexpected Token instruction');
        break;
      }

      case PROGRAM.jupiter:
        if (swap) refuse('the transaction has more than one swap');
        swap = ix;
        break;

      default:
        refuse('the transaction calls a program this page does not allow');
    }
  }

  const priorityFee = (BigInt(computeUnits) * microLamportsPerUnit) / 1_000_000n;
  if (priorityFee > MAX_PRIORITY_FEE) refuse('the priority fee is above the limit');

  if (!swap) refuse('the transaction has no Jupiter swap');
  const d = swap.data;
  const a = swap.accounts;
  const kind = SWAPS[hex(d.subarray(0, 8))];
  if (!kind) refuse('the swap is a kind this page cannot read');
  if (kind.mode !== mode) refuse(`the swap is not ${mode}`);

  const args = kind.shared ? 9 : 8;
  if (d.length < args + 22 || a.length < (kind.shared ? 12 : 10)) refuse('the swap instruction is cut short');
  const [authority, source, destination] = kind.shared ? [a[1], a[2], a[5]] : [a[0], a[1], a[7]];
  if (authority !== 0) refuse('the swap is not authorised by this wallet');
  if (destination !== coinbase) refuse('the swap does not send its output to the Coinbase USDC account');

  // The only SOL that may leave this wallet is what gets wrapped into the account
  // the swap spends from. No tips, no side payments.
  let wrapped = 0n;
  for (const t of transfers) {
    if (t.to !== source) refuse('the transaction sends SOL somewhere other than the swap');
    wrapped += t.lamports;
  }

  const first = u64(d, args);
  const second = u64(d, args + 8);
  const slippage = BigInt(u16(d, args + 16));
  // ExactOut: (output, quoted input). ExactIn: (input, quoted output). The program
  // fails the swap beyond the slippage, so these are hard bounds.
  const delivers = mode === 'ExactOut' ? first : (second * (BPS - slippage)) / BPS;
  const spends = mode === 'ExactOut' ? ceilDiv(second * (BPS + slippage), BPS) : first;

  if (delivers < units) refuse('the transaction could deliver less than the amount');
  if (spends > cap) refuse('the transaction could spend more SOL than the live price allows');
  if (wrapped > cap) refuse('the transaction moves more SOL than the live price allows');

  return { delivers, spends };
}
