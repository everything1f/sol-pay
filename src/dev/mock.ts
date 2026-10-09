// Development only: pretend wallets and a pretend Jupiter, so every screen can be
// reached without a wallet and without moving money. `npm run dev` loads this;
// the production build leaves it out entirely.

import { b58encode } from '../base58';
import { JUPITER, SOL_MINT } from '../config';
import { lamportsFor } from '../sizing';
import type { Order } from '../verify';
import { fakeKey, forgeOrder, type Recipe } from './forge';

const CASES: Record<string, string> = {
  paid: 'Payment succeeds',
  legacy: 'Succeeds through the older Phantom API',
  reject: 'Signature rejected in Phantom',
  expired: 'Quote expires once, then succeeds',
  onchain: 'Swap fails on-chain',
  'wrong-receiver': 'Refused: wrong destination',
  overpriced: 'Refused: costs too much SOL',
  short: 'Not enough SOL',
  empty: 'Wallet with no SOL at all',
  limited: 'Jupiter rate-limits',
  offline: 'Jupiter unreachable',
  lost: 'Sent, confirmation lost',
  'send-only': 'Jupiter rejects the signed copy, Phantom sends',
  'exact-in': 'ExactOut unavailable, sized ExactIn instead',
  ask: 'Site not trusted yet (connect prompt)',
  declined: 'Connection declined',
  'no-wallet': 'Opened outside a wallet',
  solflare: 'Solflare: payment succeeds',
  'solflare-old': 'Solflare through its older API',
  'solflare-ask': 'Solflare: site not trusted yet',
  both: 'Both wallets installed (choose one)',
  slow: 'Slow network',
  live: 'Live Jupiter quotes, execution faked',
};

const PRICE = 110.14;
const PRICE_UNITS = 110_140_000n;
/** For the "live" case Jupiter needs a real, funded wallet to quote against. Nothing can be signed for it here. */
const LIVE_WALLET = 'FVsEAodENALwEXLgQ61dafWsRCv7a2w39zMC8n4g1Buo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejection = () => Object.assign(new Error('User rejected the request.'), { code: 4001 });

export function install(): void {
  const params = new URLSearchParams(location.search);
  const chosen = params.get('case') ?? sessionStorage.getItem('case') ?? 'paid';
  const scenario = chosen in CASES ? chosen : 'paid';
  sessionStorage.setItem('case', scenario);
  addPicker(scenario);

  const pace = scenario === 'slow' ? 5 : 1;
  const solflare = scenario.startsWith('solflare');
  if (scenario !== 'no-wallet' && !solflare) {
    installWallet('Phantom', scenario, scenario === 'live' ? LIVE_WALLET : fakeKey(100), pace);
  }
  if (solflare || scenario === 'both') installWallet('Solflare', scenario, fakeKey(101), pace);
  installJupiter(scenario, pace);
}

function addPicker(current: string): void {
  const select = document.createElement('select');
  select.style.cssText =
    'max-width:190px;font:12px system-ui;padding:3px 4px;background:#16261f;color:#efeadb;' +
    'border:1px solid #3a4d43;border-radius:6px';
  for (const [value, label] of Object.entries(CASES)) select.add(new Option(label, value, false, value === current));
  select.addEventListener('change', () => {
    sessionStorage.setItem('case', select.value);
    for (const key of ['send-only', 'send-only-solflare', 'wallet']) localStorage.removeItem(key);
    location.search = '';
  });
  // Labelled, so it is plain that this menu is a preview tool and not part of the page.
  const label = document.createElement('label');
  label.textContent = 'Preview only. Simulate: ';
  label.style.cssText =
    'position:fixed;right:8px;top:44px;z-index:9;font:12px system-ui;color:#8fa094;' +
    'display:flex;align-items:center;gap:6px';
  label.append(select);
  document.body.append(label);
}

/** A copy of the transaction with its signature slot filled in. */
function signed(transaction: Uint8Array): Uint8Array {
  const out = Uint8Array.from(transaction);
  crypto.getRandomValues(out.subarray(1, 65));
  return out;
}

function installWallet(name: 'Phantom' | 'Solflare', scenario: string, address: string, pace: number): void {
  const phantom = name === 'Phantom';
  let trusted = !['ask', 'declined', 'solflare-ask'].includes(scenario);
  let declineNext = scenario === 'declined';
  let connected = false;

  const approve = async () => {
    await sleep(1300 * pace); // the time it takes to read the wallet's sheet and tap Approve
    if (scenario === 'reject') throw rejection();
  };

  /** The wallet's own connect prompt. */
  const ask = async () => {
    await sleep(900 * pace);
    if (declineNext) {
      declineNext = false;
      throw rejection();
    }
    trusted = true;
  };

  const provider = {
    isPhantom: phantom,
    isSolflare: !phantom,
    publicKey: undefined as { toString(): string } | undefined,
    on() {},
    async connect(options?: { onlyIfTrusted?: boolean }) {
      // Only Phantom understands onlyIfTrusted. Solflare's older API just prompts.
      if (phantom && options?.onlyIfTrusted) {
        await sleep(40);
        if (!trusted) throw rejection();
      } else {
        await ask();
      }
      connected = true;
      provider.publicKey = { toString: () => address };
      // Phantom answers with the key; Solflare answers true and leaves the key on itself.
      return phantom ? { publicKey: provider.publicKey } : true;
    },
    // The older API takes and returns web3.js-style objects.
    async signTransaction(transaction: { version?: unknown; serialize(): Uint8Array }) {
      if (transaction.version !== 0) throw new Error('mock wallet expected a versioned transaction object');
      await approve();
      const bytes = signed(transaction.serialize());
      return { serialize: () => bytes };
    },
    async signAndSendTransaction(transaction: { serialize(): Uint8Array }) {
      await approve();
      const signature = b58encode(signed(transaction.serialize()).subarray(1, 65));
      return phantom ? { signature } : signature;
    },
  };
  if (phantom) (window as any).phantom = { solana: provider };
  else (window as any).solflare = provider;

  // No Wallet Standard: forces the on-demand web3.js path.
  if (scenario === 'legacy' || scenario === 'solflare-old') return;

  const account = { address };
  const standard = {
    name,
    get accounts() {
      return connected ? [account] : [];
    },
    features: {
      'standard:connect': {
        connect: async (input?: { silent?: boolean }) => {
          if (input?.silent) {
            await sleep(40);
            if (!trusted) return { accounts: [] };
          } else if (!connected) {
            await ask();
          }
          connected = true;
          return { accounts: [account] };
        },
      },
      'standard:events': { on: () => () => {} },
      'solana:signTransaction': {
        signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
          await approve();
          return [{ signedTransaction: signed(transaction) }];
        },
      },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
          await approve();
          return [{ signature: signed(transaction).subarray(1, 65) }];
        },
      },
    },
  };
  window.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', {
      detail: (api: { register(wallet: unknown): void }) => api.register(standard),
    }),
  );
}

function installJupiter(scenario: string, pace: number): void {
  const real = window.fetch.bind(window);
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  let last: Order | undefined;
  let executions = 0;

  const order = (query: URLSearchParams): Response => {
    const taker = query.get('taker') ?? '';
    const amount = BigInt(query.get('amount')!);
    const exactOut = query.get('swapMode') === 'ExactOut';
    // With no wallet named, Jupiter returns a bare quote and no transaction.
    if (!taker) return json({ swapMode: query.get('swapMode'), outAmount: '1', transaction: null });
    if (scenario === 'empty') return json({ error: 'Failed to get quotes' }, 400);

    if (scenario === 'limited') {
      return json({ error: 'Rate limit exceeded' }, 429, { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 1) });
    }
    if (scenario === 'short') {
      return json({ swapMode: query.get('swapMode'), taker, transaction: '', errorCode: 1, errorMessage: 'Insufficient funds' });
    }
    if (scenario === 'exact-in' && exactOut) return json({ error: 'swapMode ExactOut is not supported' }, 400);

    const recipe: Recipe = exactOut
      ? { taker, mode: 'ExactOut', first: amount, second: (lamportsFor(amount, PRICE_UNITS) * 10_004n) / 10_000n, slippageBps: 26 }
      : { taker, mode: 'ExactIn', first: amount, second: (amount * PRICE_UNITS * 9_993n) / 10_000_000_000_000n, slippageBps: 26 };
    if (scenario === 'wrong-receiver') recipe.destination = fakeKey(55);
    if (scenario === 'overpriced' && exactOut) recipe.second = (recipe.second * 108n) / 100n;

    last = forgeOrder(recipe, { requestId: crypto.randomUUID() });
    return json({ ...last, router: 'metis', mode: 'manual' });
  };

  const execute = (): Response => {
    executions++;
    const signature = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    if (scenario === 'expired' && executions === 1) return json({ status: 'Failed', code: -1004, error: 'Invalid block height' });
    if (scenario === 'onchain') return json({ status: 'Failed', code: 6001, signature, error: 'Slippage tolerance exceeded' });
    if (scenario === 'send-only') return json({ status: 'Failed', code: -3, error: 'Invalid message bytes' }, 400);
    return json({
      status: 'Success',
      code: 0,
      signature,
      totalInputAmount: last?.inAmount,
      inputAmountResult: last?.inAmount,
      outputAmountResult: last?.outAmount,
    });
  };

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== JUPITER) return real(input, init);

    const executing = url.pathname === '/swap/v2/execute';
    if (scenario === 'live' && !executing) {
      const response = await real(input, init);
      if (url.pathname === '/swap/v2/order') last = await response.clone().json();
      return response;
    }

    await sleep((executing ? 1100 : 260) * pace);
    if (scenario === 'offline' || (scenario === 'lost' && executing)) throw new TypeError('Failed to fetch');
    if (url.pathname === '/price/v3') return json({ [SOL_MINT]: { usdPrice: PRICE, decimals: 9 } });
    if (url.pathname === '/swap/v2/order') return order(url.searchParams);
    if (executing) return execute();
    return json({ error: 'not mocked' }, 404);
  };
}
