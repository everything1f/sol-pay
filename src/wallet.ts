// Wallets. All signing happens inside the wallet; this file only passes bytes back and forth.
//
// Two wallets are supported, Phantom and Solflare. Each can be reached two ways.
// Wallet Standard takes raw transaction bytes, so it is used for signing whenever the
// wallet offers it. The older injected provider wants a web3.js object, which is
// loaded on demand (see legacy.ts) and never touches the main bundle.

import { b58encode } from './base58';

/** The user dismissed the wallet's prompt. Not an error worth showing. */
export class Rejected extends Error {}

/** A wallet this page can work with. */
export interface Kind {
  id: 'phantom' | 'solflare';
  name: string;
}

interface StandardAccount {
  address: string;
}
interface StandardWallet {
  name: string;
  accounts: readonly StandardAccount[];
  features: Record<string, any>;
}
type Provider = any;

interface Driver extends Kind {
  /** The wallet's own object on the page, if the wallet is here. */
  injected(): Provider | undefined;
  /** Its "open this page in my browser" link, up to the encoded page address. */
  browse: string;
  /**
   * How to connect when both routes exist. Phantom's injected connect takes
   * { onlyIfTrusted: true } for a connect with no prompt, so it goes first there.
   * Solflare documents no such option, so its Wallet Standard connect is used.
   */
  connectVia: 'injected' | 'standard';
  /**
   * Whether the wallet broadcasts the transaction itself. Otherwise it only signs
   * and Jupiter broadcasts. Solflare is asked to send, which is what wallets recommend.
   */
  sends: boolean;
}

const DRIVERS: readonly Driver[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    browse: 'https://phantom.com/ul/browse/',
    connectVia: 'injected',
    sends: false,
    injected: () => {
      const provider = (window as any).phantom?.solana;
      return provider?.isPhantom ? provider : undefined;
    },
  },
  {
    id: 'solflare',
    name: 'Solflare',
    browse: 'https://solflare.com/ul/v1/browse/',
    connectVia: 'standard',
    sends: true,
    injected: () => {
      const provider = (window as any).solflare;
      return provider?.isSolflare ? provider : undefined;
    },
  },
];

/** Every wallet the page knows, whether or not it is present. */
export const supported: readonly Kind[] = DRIVERS;

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

const driver = (kind: Kind): Driver => DRIVERS.find((d) => d.id === kind.id)!;

/** The wallet's Wallet Standard entry. Matched by name, so an unknown wallet is never used. */
const standard = (kind: Kind): StandardWallet | undefined => standardWallets.find((w) => w.name === kind.name);

/** The supported wallets that are present on this page, Phantom first. */
export function available(): Kind[] {
  return DRIVERS.filter((d) => d.injected() || standard(d));
}

/** A link that opens `page` inside the wallet's own browser. */
export function browseLink(kind: Kind, page: string, origin: string): string {
  return `${driver(kind).browse}${encodeURIComponent(page)}?ref=${encodeURIComponent(origin)}`;
}

/** Whether this wallet is asked to broadcast the transaction itself rather than only sign it. */
export function sendsItself(kind: Kind): boolean {
  return driver(kind).sends;
}

/** Whether to talk to the wallet's injected object rather than its Wallet Standard entry. */
function viaInjected(d: Driver): Provider | undefined {
  const injected = d.injected();
  return injected && (d.connectVia === 'injected' || !standard(d)) ? injected : undefined;
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
export function connect(kind: Kind, silent: boolean): Promise<string> {
  return prompt(async () => {
    const d = driver(kind);
    const injected = viaInjected(d);
    const wallet = standard(d);
    let address: unknown;
    if (injected) {
      // Only Phantom's injected connect is known to have a no-prompt form.
      if (silent && d.connectVia !== 'injected') throw new Rejected();
      const result = await injected.connect(silent ? { onlyIfTrusted: true } : undefined);
      address = result?.publicKey ?? injected.publicKey;
    } else if (wallet) {
      const result = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined);
      address = (result?.accounts ?? wallet.accounts)[0]?.address;
    } else {
      throw new Error(`${d.name} is not available on this page.`);
    }
    if (!address) throw new Rejected();
    return String(address);
  });
}

/** Calls back with the new address, or undefined when the wallet disconnects. */
export function onAccountChange(kind: Kind, changed: (address: string | undefined) => void): void {
  const d = driver(kind);
  const injected = viaInjected(d);
  if (injected) {
    injected.on?.('accountChanged', (key: unknown) => changed(key ? String(key) : undefined));
    injected.on?.('disconnect', () => changed(undefined));
    return;
  }
  standard(d)?.features['standard:events']?.on('change', (change: { accounts?: readonly StandardAccount[] }) => {
    if (change.accounts) changed(change.accounts[0]?.address);
  });
}

async function standardAccount(kind: Kind, address: string): Promise<[StandardWallet, StandardAccount] | undefined> {
  const wallet = standard(kind);
  if (!wallet) return undefined;
  const find = () => wallet.accounts.find((a) => a.address === address);
  if (!find()) {
    await wallet.features['standard:connect']?.connect({ silent: true }).catch(() => {});
  }
  const account = find();
  return account ? [wallet, account] : undefined;
}

/** What this wallet offers, for choosing a flow and for the debug readout. */
export async function abilities(kind: Kind, address: string) {
  const [wallet] = (await standardAccount(kind, address)) ?? [];
  const injected = driver(kind).injected();
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

/** Asks the wallet to sign without sending. Returns the signed transaction. */
export function sign(kind: Kind, address: string, transaction: Uint8Array): Promise<Uint8Array> {
  return prompt(async () => {
    const found = await standardAccount(kind, address);
    const feature = found?.[0].features[SIGN];
    if (found && feature) {
      const [out] = await feature.signTransaction({ account: found[1], transaction, chain: CHAIN });
      return new Uint8Array(out.signedTransaction);
    }
    const { toVersioned } = await import('./legacy');
    const signed = await driver(kind).injected().signTransaction(await toVersioned(transaction));
    return new Uint8Array(signed.serialize());
  });
}

/** Asks the wallet to sign and broadcast. Returns the transaction signature. */
export function signAndSend(kind: Kind, address: string, transaction: Uint8Array): Promise<string> {
  return prompt(async () => {
    const found = await standardAccount(kind, address);
    const feature = found?.[0].features[SEND];
    if (found && feature) {
      const [out] = await feature.signAndSendTransaction({ account: found[1], transaction, chain: CHAIN });
      return b58encode(new Uint8Array(out.signature));
    }
    const { toVersioned } = await import('./legacy');
    const sent = await driver(kind).injected().signAndSendTransaction(await toVersioned(transaction));
    // Phantom answers { signature }; Solflare's older API answers the signature itself.
    return String(typeof sent === 'string' ? sent : sent.signature);
  });
}
