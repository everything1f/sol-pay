import { afterEach, describe, expect, it, vi } from 'vitest';
import { b58encode } from '../src/base58';
import { fakeKey, forgeTransaction } from '../src/dev/forge';

// The older-API tests load web3.js, which takes several seconds the first time.
vi.setConfig({ testTimeout: 30_000 });

const ADDRESS = fakeKey(100);
const OTHER = fakeKey(101);
const transaction = forgeTransaction({ taker: ADDRESS, mode: 'ExactOut', first: 1_000_000n, second: 9_000_000n });
const signedCopy = Uint8Array.from(transaction).fill(7, 1, 65);
const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

/** A wallet's older, injected object. Phantom's connect answers with the key; Solflare's answers true. */
function injected(name: 'Phantom' | 'Solflare', address = ADDRESS) {
  const provider = {
    isPhantom: name === 'Phantom',
    isSolflare: name === 'Solflare',
    publicKey: undefined as { toString(): string } | undefined,
    on: vi.fn(),
    connect: vi.fn(async (_options?: unknown) => {
      provider.publicKey = { toString: () => address };
      return name === 'Phantom' ? { publicKey: provider.publicKey } : true;
    }),
    signTransaction: vi.fn(async (_tx: { version: unknown; serialize(): Uint8Array }) => ({ serialize: () => signedCopy })),
    signAndSendTransaction: vi.fn(async (_tx: unknown): Promise<unknown> =>
      name === 'Phantom' ? { signature: 'sig-from-provider' } : 'sig-from-provider',
    ),
  };
  return provider;
}

/** A wallet's Wallet Standard entry. */
function standard(name: string, address = ADDRESS, features: string[] = ['sign', 'send']) {
  const account = { address };
  let connected = false;
  const wallet = {
    name,
    get accounts() {
      return connected ? [account] : [];
    },
    connect: vi.fn(async (_input?: { silent?: boolean }) => {
      connected = true;
      return { accounts: [account] };
    }),
    signTransaction: vi.fn(async (_input: unknown) => [{ signedTransaction: signedCopy }]),
    signAndSendTransaction: vi.fn(async (_input: unknown) => [{ signature: new Uint8Array(64).fill(9) }]),
    onChange: vi.fn(),
    features: {} as Record<string, unknown>,
  };
  wallet.features = {
    'standard:connect': { connect: wallet.connect },
    'standard:events': { on: wallet.onChange },
    ...(features.includes('sign') ? { 'solana:signTransaction': { signTransaction: wallet.signTransaction } } : {}),
    ...(features.includes('send')
      ? { 'solana:signAndSendTransaction': { signAndSendTransaction: wallet.signAndSendTransaction } }
      : {}),
  };
  return wallet;
}

/** Loads wallet.ts into a pretend page that has the given wallets on it. */
async function page(env: { phantom?: unknown; solflare?: unknown; standard?: unknown[] }) {
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  if (env.phantom) win.phantom = { solana: env.phantom };
  if (env.solflare) win.solflare = env.solflare;
  vi.stubGlobal('window', win);
  vi.resetModules();
  const wallet = await import('../src/wallet');
  for (const entry of env.standard ?? []) {
    win.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: (api: { register(w: unknown): void }) => api.register(entry),
      }),
    );
  }
  const [phantom, solflare] = wallet.supported;
  return { wallet, phantom, solflare };
}

afterEach(() => vi.unstubAllGlobals());

describe('finding wallets', () => {
  it('finds nothing on a plain page', async () => {
    const { wallet } = await page({});
    expect(wallet.available()).toEqual([]);
  });

  it('finds Phantom alone inside Phantom', async () => {
    const { wallet } = await page({ phantom: injected('Phantom'), standard: [standard('Phantom')] });
    expect(wallet.available().map((k) => k.id)).toEqual(['phantom']);
  });

  it('finds Solflare alone inside Solflare, by either of its two faces', async () => {
    expect((await page({ solflare: injected('Solflare') })).wallet.available().map((k) => k.id)).toEqual(['solflare']);
    expect((await page({ standard: [standard('Solflare')] })).wallet.available().map((k) => k.id)).toEqual(['solflare']);
  });

  it('finds both on a computer with both extensions, Phantom first', async () => {
    const { wallet } = await page({
      phantom: injected('Phantom'),
      solflare: injected('Solflare'),
      standard: [standard('Solflare'), standard('Phantom')],
    });
    expect(wallet.available().map((k) => k.id)).toEqual(['phantom', 'solflare']);
  });

  it('ignores wallets it does not know, and objects that only look like one', async () => {
    const { wallet } = await page({
      phantom: { ...injected('Phantom'), isPhantom: false },
      solflare: { connect() {} },
      standard: [standard('Backpack')],
    });
    expect(wallet.available()).toEqual([]);
  });

  it('builds each wallet\'s own "open in my browser" link', async () => {
    const { wallet, phantom, solflare } = await page({});
    const here = 'https://sol-pay.example.dev/?debug';
    expect(wallet.browseLink(phantom, here, 'https://sol-pay.example.dev')).toBe(
      'https://phantom.com/ul/browse/https%3A%2F%2Fsol-pay.example.dev%2F%3Fdebug?ref=https%3A%2F%2Fsol-pay.example.dev',
    );
    expect(wallet.browseLink(solflare, here, 'https://sol-pay.example.dev')).toBe(
      'https://solflare.com/ul/v1/browse/https%3A%2F%2Fsol-pay.example.dev%2F%3Fdebug?ref=https%3A%2F%2Fsol-pay.example.dev',
    );
  });
});

describe('Phantom, unchanged', () => {
  it('connects through its injected object, silently with onlyIfTrusted', async () => {
    const provider = injected('Phantom');
    const entry = standard('Phantom');
    const { wallet, phantom } = await page({ phantom: provider, standard: [entry] });

    expect(await wallet.connect(phantom, true)).toBe(ADDRESS);
    expect(provider.connect).toHaveBeenLastCalledWith({ onlyIfTrusted: true });
    expect(await wallet.connect(phantom, false)).toBe(ADDRESS);
    expect(provider.connect).toHaveBeenLastCalledWith(undefined);
    expect(entry.connect).not.toHaveBeenCalled();
  });

  it('listens for account changes on its injected object', async () => {
    const provider = injected('Phantom');
    const entry = standard('Phantom');
    const { wallet, phantom } = await page({ phantom: provider, standard: [entry] });
    wallet.onAccountChange(phantom, () => {});
    expect(provider.on.mock.calls.map((c) => c[0])).toEqual(['accountChanged', 'disconnect']);
    expect(entry.onChange).not.toHaveBeenCalled();
  });

  it('signs raw bytes through Wallet Standard when Phantom offers it', async () => {
    const provider = injected('Phantom');
    const entry = standard('Phantom');
    const { wallet, phantom } = await page({ phantom: provider, standard: [entry] });
    await wallet.connect(phantom, true);

    expect(await wallet.sign(phantom, ADDRESS, transaction)).toEqual(signedCopy);
    expect(entry.signTransaction).toHaveBeenCalledExactlyOnceWith({
      account: { address: ADDRESS },
      transaction,
      chain: 'solana:mainnet',
    });
    expect(provider.signTransaction).not.toHaveBeenCalled();
  });

  it('falls back to the injected object, handing it a real web3.js transaction', async () => {
    const provider = injected('Phantom');
    const { wallet, phantom } = await page({ phantom: provider });
    await wallet.connect(phantom, true);

    expect(await wallet.sign(phantom, ADDRESS, transaction)).toEqual(signedCopy);
    const handed = provider.signTransaction.mock.calls[0][0];
    expect(handed.version).toBe(0);
    expect(new Uint8Array(handed.serialize())).toEqual(transaction);
  });

  it('reports what it offers', async () => {
    const withStandard = await page({ phantom: injected('Phantom'), standard: [standard('Phantom')] });
    await withStandard.wallet.connect(withStandard.phantom, true);
    expect(await withStandard.wallet.abilities(withStandard.phantom, ADDRESS)).toEqual({
      standardSign: true,
      standardSend: true,
      providerSign: true,
      providerSend: true,
    });

    const without = await page({ phantom: injected('Phantom') });
    expect(await without.wallet.abilities(without.phantom, ADDRESS)).toMatchObject({
      standardSign: false,
      standardSend: false,
      providerSign: true,
    });
  });

  it('sends through Wallet Standard, or through the injected object', async () => {
    const entry = standard('Phantom');
    const first = await page({ phantom: injected('Phantom'), standard: [entry] });
    await first.wallet.connect(first.phantom, true);
    expect(await first.wallet.signAndSend(first.phantom, ADDRESS, transaction)).toBe(b58encode(new Uint8Array(64).fill(9)));

    const second = await page({ phantom: injected('Phantom') });
    expect(await second.wallet.signAndSend(second.phantom, ADDRESS, transaction)).toBe('sig-from-provider');
  });

  it('turns a dismissed prompt into Rejected, and passes other errors through', async () => {
    const provider = injected('Phantom');
    const { wallet, phantom } = await page({ phantom: provider });
    provider.connect.mockRejectedValueOnce(rejection());
    await expect(wallet.connect(phantom, false)).rejects.toBeInstanceOf(wallet.Rejected);
    provider.connect.mockRejectedValueOnce(new Error('wallet is locked'));
    await expect(wallet.connect(phantom, false)).rejects.toThrow('wallet is locked');
  });

  it('is not disturbed by Solflare being installed beside it', async () => {
    const provider = injected('Phantom');
    const mine = standard('Phantom');
    const theirs = standard('Solflare', OTHER);
    const { wallet, phantom } = await page({
      phantom: provider,
      solflare: injected('Solflare', OTHER),
      standard: [theirs, mine],
    });
    expect(await wallet.connect(phantom, true)).toBe(ADDRESS);
    await wallet.sign(phantom, ADDRESS, transaction);
    expect(mine.signTransaction).toHaveBeenCalledOnce();
    expect(theirs.signTransaction).not.toHaveBeenCalled();
    expect(theirs.connect).not.toHaveBeenCalled();
  });
});

describe('Solflare', () => {
  it('connects through Wallet Standard, silently first', async () => {
    const provider = injected('Solflare');
    const entry = standard('Solflare');
    const { wallet, solflare } = await page({ solflare: provider, standard: [entry] });

    expect(await wallet.connect(solflare, true)).toBe(ADDRESS);
    expect(entry.connect).toHaveBeenLastCalledWith({ silent: true });
    expect(await wallet.connect(solflare, false)).toBe(ADDRESS);
    expect(entry.connect).toHaveBeenLastCalledWith(undefined);
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('treats a silent connect that returns no account as "ask the user"', async () => {
    const entry = standard('Solflare');
    entry.connect.mockResolvedValueOnce({ accounts: [] } as never);
    const { wallet, solflare } = await page({ standard: [entry] });
    await expect(wallet.connect(solflare, true)).rejects.toBeInstanceOf(wallet.Rejected);
  });

  it('signs raw bytes through Wallet Standard', async () => {
    const entry = standard('Solflare');
    const { wallet, solflare } = await page({ solflare: injected('Solflare'), standard: [entry] });
    await wallet.connect(solflare, false);
    expect(await wallet.sign(solflare, ADDRESS, transaction)).toEqual(signedCopy);
    expect(entry.signTransaction).toHaveBeenCalledExactlyOnceWith({
      account: { address: ADDRESS },
      transaction,
      chain: 'solana:mainnet',
    });
  });

  it('listens for account changes through Wallet Standard', async () => {
    const provider = injected('Solflare');
    const entry = standard('Solflare');
    const { wallet, solflare } = await page({ solflare: provider, standard: [entry] });
    const seen: (string | undefined)[] = [];
    wallet.onAccountChange(solflare, (address) => seen.push(address));
    const [event, handler] = entry.onChange.mock.calls[0] as [string, (c: unknown) => void];
    expect(event).toBe('change');
    handler({ accounts: [{ address: OTHER }] });
    handler({ accounts: [] });
    handler({ features: {} }); // a change that is not about accounts
    expect(seen).toEqual([OTHER, undefined]);
    expect(provider.on).not.toHaveBeenCalled();
  });

  describe('with only its older injected object', () => {
    it('never prompts on a silent connect, and connects when asked to', async () => {
      const provider = injected('Solflare');
      const { wallet, solflare } = await page({ solflare: provider });
      await expect(wallet.connect(solflare, true)).rejects.toBeInstanceOf(wallet.Rejected);
      expect(provider.connect).not.toHaveBeenCalled();
      // Its connect answers true and leaves the key on the object.
      expect(await wallet.connect(solflare, false)).toBe(ADDRESS);
    });

    it('counts a connect that leaves no key as dismissed', async () => {
      const provider = injected('Solflare');
      provider.connect.mockResolvedValueOnce(false as never);
      const { wallet, solflare } = await page({ solflare: provider });
      await expect(wallet.connect(solflare, false)).rejects.toBeInstanceOf(wallet.Rejected);
    });

    it('signs with a web3.js transaction, and accepts a bare signature back from a send', async () => {
      const provider = injected('Solflare');
      const { wallet, solflare } = await page({ solflare: provider });
      await wallet.connect(solflare, false);
      expect(await wallet.sign(solflare, ADDRESS, transaction)).toEqual(signedCopy);
      expect(provider.signTransaction.mock.calls[0][0].version).toBe(0);
      expect(await wallet.signAndSend(solflare, ADDRESS, transaction)).toBe('sig-from-provider');
    });
  });
});
