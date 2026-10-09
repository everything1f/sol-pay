// A reader for Solana v0 transactions: just enough to inspect what is about to be signed.

import { b58encode } from './base58';

export interface Instruction {
  /** Index of the program in the account list. */
  program: number;
  /** Indexes into the account list: static keys first, then lookup-table addresses. */
  accounts: Uint8Array;
  data: Uint8Array;
}

export interface Transaction {
  signatures: Uint8Array[];
  signers: number;
  readonlySigned: number;
  readonlyUnsigned: number;
  /** Static account keys, base58. Addresses loaded from lookup tables are not listed here. */
  keys: string[];
  instructions: Instruction[];
  lookupTables: number;
}

export function decodeTransaction(bytes: Uint8Array): Transaction {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (at + n > bytes.length) throw new Error('transaction is cut short');
    at += n;
    return bytes.subarray(at - n, at);
  };
  const byte = (): number => take(1)[0];
  const count = (): number => {
    // Solana's compact-u16: 7 bits per byte, low bits first.
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = byte();
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error('bad length prefix');
  };
  const list = <T>(read: () => T): T[] => Array.from({ length: count() }, read);

  const signatures = list(() => take(64));
  if (byte() !== 0x80) throw new Error('not a v0 transaction');
  const signers = byte();
  const readonlySigned = byte();
  const readonlyUnsigned = byte();
  const keys = list(() => b58encode(take(32)));
  take(32); // recent blockhash
  const instructions = list(() => ({ program: byte(), accounts: take(count()), data: take(count()) }));
  const lookupTables = list(() => {
    take(32); // table address
    take(count()); // writable indexes
    take(count()); // read-only indexes
  }).length;
  if (at !== bytes.length) throw new Error('unexpected bytes after the transaction');

  return { signatures, signers, readonlySigned, readonlyUnsigned, keys, instructions, lookupTables };
}

/** The transaction id: its first signature, base58. Only meaningful once signed. */
export const signatureOf = (signed: Uint8Array): string => b58encode(signed.subarray(1, 65));

export const u16 = (d: Uint8Array, at: number): number => d[at] | (d[at + 1] << 8);

export const u32 = (d: Uint8Array, at: number): number =>
  (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

export function u64(d: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(d[at + i]);
  return value;
}

export const hex = (d: Uint8Array): string =>
  Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
