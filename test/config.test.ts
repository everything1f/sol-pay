import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b58decode, b58encode, shorten } from '../src/base58';
import { MAX_UNITS, MAX_USD, RECEIVER, RECEIVER_USDC_ACCOUNT, SOL_MINT, USDC_MINT } from '../src/config';

// Derives an associated token account the way Solana does, independently of the app.
const P = 2n ** 255n - 19n;
const pow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
const inverse = (x: bigint) => pow(((x % P) + P) % P, P - 2n);
const D = (((-121665n * inverse(121666n)) % P) + P) % P;

function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = y * 256n + BigInt(i === 31 ? bytes[i] & 127 : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = (((y2 - 1n + P) % P) * inverse((D * y2 + 1n) % P)) % P;
  return x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n;
}

function associatedTokenAccount(owner: string, mint: string): string {
  const tokenProgram = b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const program = b58decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash('sha256')
      .update(b58decode(owner))
      .update(tokenProgram)
      .update(b58decode(mint))
      .update(Uint8Array.of(bump))
      .update(program)
      .update('ProgramDerivedAddress')
      .digest();
    if (!onCurve(hash)) return b58encode(hash);
  }
  throw new Error('no address found');
}

describe('constants', () => {
  it('RECEIVER_USDC_ACCOUNT is the USDC token account derived from RECEIVER', () => {
    expect(associatedTokenAccount(RECEIVER, USDC_MINT)).toBe(RECEIVER_USDC_ACCOUNT);
  });

  it('the derivation matches a known wallet, so the check above means something', () => {
    // The paying wallet's USDC account, as seen on-chain.
    expect(associatedTokenAccount('FVsEAodENALwEXLgQ61dafWsRCv7a2w39zMC8n4g1Buo', USDC_MINT)).toBe(
      '9j38EakBWuS2TW99bvwBhPt6aiUiJsabTNCjQPce7fdP',
    );
  });

  it('every address is a 32-byte key', () => {
    for (const key of [RECEIVER, RECEIVER_USDC_ACCOUNT, SOL_MINT, USDC_MINT]) {
      expect(b58decode(key)).toHaveLength(32);
    }
  });

  it('the cap is $100', () => {
    expect(MAX_USD).toBe(100);
    expect(MAX_UNITS).toBe(100_000_000n);
  });
});

describe('base58', () => {
  it('round-trips addresses', () => {
    for (const key of [RECEIVER, SOL_MINT, USDC_MINT, '11111111111111111111111111111111']) {
      expect(b58encode(b58decode(key))).toBe(key);
    }
  });

  it('keeps leading zero bytes', () => {
    expect(b58decode('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(b58encode(Uint8Array.of(0, 0, 1))).toBe('112');
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => b58decode('0OIl')).toThrow();
  });

  it('shortens an address for display', () => {
    expect(shorten(RECEIVER)).toBe('Euid…VNvU');
  });
});
