// Phantom. All signing happens inside the wallet; this file only passes bytes back and forth.
//
// Phantom exposes two interfaces. Wallet Standard takes raw transaction bytes, so it is
// used whenever Phantom offers it. The older injected provider wants a web3.js object,
// which is loaded on demand (see legacy.ts) and never touches the main bundle.

import { b58encode } from './base58';

/** The user dismissed Phantom's prompt. Not an error worth showing. */
export class Rejected extends Error {}

interface StandardAccount {
  address: string;
}
interface StandardWallet {
  name: string;
  accounts: readonly StandardAccount[];
  features: Record<string, any>;
}
type Provider = any;

const CHAIN = 'solana:mainnet';
const SIGN = 'solana:signTransaction';
const SEND = 'solana:signAndSendTransaction';

const standardWallets: StandardWallet[] = [];

/** Wallet Standard discovery: wallets announce themselves, in either order relative to the page. */
function discover(): void {
  const api = Object.freeze({
    register: (...wallets: StandardWallet[]) => {
      standardWallets.push(...wallets);
      return () => {};
    },
  });
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    (event as CustomEvent<(a: typeof api) => void>).detail(api);
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
}
discover();

export function provider(): Provider | undefined {
  const injected = (window as any).phantom?.solana;
  return injected?.isPhantom ? injected : undefined;
}

function wasRejected(error: unknown): boolean {
  const e = error as { code?: number; message?: string } | undefined;
  return e?.code === 4001 || /reject|cancel|declin|denied/i.test(e?.message ?? '');
}

async function prompt<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    throw wasRejected(error) ? new Rejected() : error;
  }
}

/** Connects and returns the wallet address. `silent` never opens a prompt. */
export function connect(silent: boolean): Promise<string> {
  return prompt(async () => {
    const injected = provider();
    if (!injected) throw new Error('Phantom is not available on this page.');
    const result = await injected.connect(silent ? { onlyIfTrusted: true } : undefined);
    return String(result?.publicKey ?? injected.publicKey);
  });
}

/** Calls back with the new address, or undefined when the wallet disconnects. */
export function onAccountChange(changed: (address: string | undefined) => void): void {
  const injected = provider();
  injected?.on?.('accountChanged', (key: unknown) => changed(key ? String(key) : undefined));
  injected?.on?.('disconnect', () => changed(undefined));
}

async function standardAccount(address: string): Promise<[StandardWallet, StandardAccount] | undefined> {
  const wallet = standardWallets.find((w) => w.name === 'Phantom');
  if (!wallet) return undefined;
  const find = () => wallet.accounts.find((a) => a.address === address);
  if (!find()) {
    await wallet.features['standard:connect']?.connect({ silent: true }).catch(() => {});
  }
  const account = find();
  return account ? [wallet, account] : undefined;
}

/** What this Phantom offers, for choosing a flow and for the debug readout. */
export async function abilities(address: string) {
  const [wallet] = (await standardAccount(address)) ?? [];
  const injected = provider();
  return {
    standardSign: !!wallet?.features[SIGN],
    standardSend: !!wallet?.features[SEND],
    providerSign: typeof injected?.signTransaction === 'function',
    providerSend: typeof injected?.signAndSendTransaction === 'function',
  };
}

/** Starts loading the older-API code ahead of time, so the first Pay does not wait for it. */
export function prepareLegacy(): void {
  void import('./legacy').catch(() => {});
}

/** Asks Phantom to sign without sending. Returns the signed transaction. */
export function sign(address: string, transaction: Uint8Array): Promise<Uint8Array> {
  return prompt(async () => {
    const standard = await standardAccount(address);
    const feature = standard?.[0].features[SIGN];
    if (standard && feature) {
      const [out] = await feature.signTransaction({ account: standard[1], transaction, chain: CHAIN });
      return new Uint8Array(out.signedTransaction);
    }
    const { toVersioned } = await import('./legacy');
    const signed = await provider().signTransaction(await toVersioned(transaction));
    return new Uint8Array(signed.serialize());
  });
}

/** Asks Phantom to sign and broadcast. Returns the transaction signature. */
export function signAndSend(address: string, transaction: Uint8Array): Promise<string> {
  return prompt(async () => {
    const standard = await standardAccount(address);
    const feature = standard?.[0].features[SEND];
    if (standard && feature) {
      const [out] = await feature.signAndSendTransaction({ account: standard[1], transaction, chain: CHAIN });
      return b58encode(new Uint8Array(out.signature));
    }
    const { toVersioned } = await import('./legacy');
    const { signature } = await provider().signAndSendTransaction(await toVersioned(transaction));
    return String(signature);
  });
}
