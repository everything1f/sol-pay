import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b58encode } from '../src/base58';
import { fakeKey, forgeOrder, type Recipe } from '../src/dev/forge';
import type { Execution, Reply } from '../src/jupiter';
import type { Mode, Order } from '../src/verify';

const getOrder = vi.fn<(taker: string, amount: bigint, mode: Mode) => Promise<Reply<Order>>>();
const execute = vi.fn<(signed: string, requestId: string) => Promise<Reply<Execution>>>();
vi.mock('../src/jupiter', () => ({
  getOrder: (...a: [string, bigint, Mode]) => getOrder(...a),
  execute: (...a: [string, string]) => execute(...a),
}));

const { Failed, pay, quote } = await import('../src/pay');
const { Refusal } = await import('../src/verify');

const TAKER = fakeKey(100);
const UNITS = 25_000_000n; // $25
const PRICE = 110_000_000n; // $110 per SOL, so $25 is about 0.2273 SOL

const exactOut = (extra: Partial<Recipe> = {}): Reply<Order> => ({
  status: 200,
  body: forgeOrder({ taker: TAKER, mode: 'ExactOut', first: UNITS, second: 227_400_000n, ...extra }),
});
const done = (body: Execution, status = 200): Reply<Execution> => ({ status, body });
const success = done({
  status: 'Success',
  code: 0,
  signature: 'landed',
  outputAmountResult: '25000000',
  totalInputAmount: '227412345',
});

function hands(over: Record<string, unknown> = {}) {
  const phases: string[] = [];
  let sendOnly = false;
  const h = {
    taker: TAKER,
    units: UNITS,
    price: async () => PRICE,
    phase: (p: string) => void phases.push(p),
    canSign: true,
    sign: vi.fn(async (tx: Uint8Array) => {
      const signed = Uint8Array.from(tx);
      signed.fill(7, 1, 65);
      return signed;
    }),
    signAndSend: vi.fn(async () => 'sent-by-phantom'),
    sendOnly: () => sendOnly,
    rememberSendOnly: () => void (sendOnly = true),
    trace: () => {},
    ...over,
  };
  return { h, phases };
}

beforeEach(() => {
  getOrder.mockReset();
  execute.mockReset();
});

describe('quote', () => {
  it('asks for ExactOut with the USDC amount', async () => {
    getOrder.mockResolvedValue(exactOut());
    const q = await quote(TAKER, UNITS, PRICE);
    expect(getOrder).toHaveBeenCalledExactlyOnceWith(TAKER, UNITS, 'ExactOut');
    expect(q.checked.delivers).toBe(UNITS);
  });

  it('falls back to sizing an ExactIn order when ExactOut is not honoured', async () => {
    // Jupiter ignores swapMode and answers ExactIn; then two rounds of sizing.
    const exactIn = (input: bigint, out: bigint): Reply<Order> => ({
      status: 200,
      body: forgeOrder({ taker: TAKER, mode: 'ExactIn', first: input, second: out, slippageBps: 30 }),
    });
    getOrder.mockImplementation(async (_taker, amount, mode) => {
      if (mode === 'ExactOut') return exactIn(amount, 2_700_000n);
      return exactIn(amount, (amount * 1095n) / 10_000n); // about $109.50 per SOL
    });
    const q = await quote(TAKER, UNITS, PRICE);
    expect(getOrder.mock.calls.map((c) => c[2])).toEqual(['ExactOut', 'ExactIn', 'ExactIn']);
    expect(q.checked.delivers).toBeGreaterThanOrEqual(UNITS);
    expect(q.checked.delivers * 100n).toBeLessThanOrEqual(UNITS * 101n);
  });

  it('falls back when ExactOut is rejected outright', async () => {
    getOrder.mockImplementation(async (_taker, amount, mode) =>
      mode === 'ExactOut'
        ? { status: 400, body: { error: 'swapMode not supported' } }
        : {
            status: 200,
            body: forgeOrder({
              taker: TAKER,
              mode: 'ExactIn',
              first: amount,
              second: (amount * 1100n) / 10_000n,
              slippageBps: 10,
            }),
          },
    );
    const q = await quote(TAKER, UNITS, PRICE);
    expect(q.checked.delivers).toBeGreaterThanOrEqual(UNITS);
  });

  it('re-quotes once when a transaction fails the checks, then gives up', async () => {
    getOrder.mockResolvedValueOnce(exactOut({ destination: fakeKey(66) })).mockResolvedValueOnce(exactOut());
    await expect(quote(TAKER, UNITS, PRICE)).resolves.toBeTruthy();

    getOrder.mockReset();
    getOrder.mockResolvedValue(exactOut({ destination: fakeKey(66) }));
    await expect(quote(TAKER, UNITS, PRICE)).rejects.toBeInstanceOf(Refusal);
    expect(getOrder).toHaveBeenCalledTimes(2);
  });

  it('refuses a quote priced more than 3% above the live price', async () => {
    getOrder.mockResolvedValue(exactOut({ second: 236_000_000n }));
    await expect(quote(TAKER, UNITS, PRICE)).rejects.toThrow(/more SOL than the live price allows/);
  });

  it('says so when the wallet is short of SOL', async () => {
    getOrder.mockResolvedValue({ status: 200, body: { swapMode: 'ExactOut', transaction: '', errorCode: 1 } });
    await expect(quote(TAKER, UNITS, PRICE)).rejects.toThrow('Not enough SOL in this wallet.');
  });
});

describe('pay', () => {
  it('quotes, signs, executes and reports what Jupiter confirmed', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValue(success);
    const { h, phases } = hands();
    const outcome = await pay(h);
    // The id shown is read from the signed transaction itself, not taken from Jupiter's reply.
    const id = b58encode(new Uint8Array(64).fill(7));
    expect(outcome).toEqual({ kind: 'paid', signature: id, usdc: 25_000_000n, lamports: 227_412_345n });
    expect(phases).toEqual(['quoting', 'awaiting', 'sending']);
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'forged-request');
  });

  it('uses a warm quote without asking Jupiter again', async () => {
    getOrder.mockResolvedValue(exactOut());
    const warm = quote(TAKER, UNITS, PRICE);
    await warm;
    getOrder.mockClear();
    execute.mockResolvedValue(success);
    await pay(hands({ warm }).h);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('ignores a warm quote for another amount, or one that has gone cold', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValue(success);
    const other = Promise.resolve({ ...(await quote(TAKER, UNITS, PRICE)), units: 1_000_000n });
    const cold = Promise.resolve({ ...(await quote(TAKER, UNITS, PRICE)), at: Date.now() - 60_000 });
    getOrder.mockClear();
    await pay(hands({ warm: other }).h);
    await pay(hands({ warm: cold }).h);
    expect(getOrder).toHaveBeenCalledTimes(2);
  });

  it('lets a rejection in Phantom propagate without calling Jupiter', async () => {
    getOrder.mockResolvedValue(exactOut());
    const rejected = new Error('User rejected the request.');
    await expect(pay(hands({ sign: async () => Promise.reject(rejected) }).h)).rejects.toBe(rejected);
    expect(execute).not.toHaveBeenCalled();
  });

  it('re-quotes once when the quote expired before sending', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValueOnce(done({ status: 'Failed', code: -1004 })).mockResolvedValueOnce(success);
    const { h } = hands();
    expect((await pay(h)).kind).toBe('paid');
    expect(h.sign).toHaveBeenCalledTimes(2);
  });

  it('gives up after a second expiry', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValue(done({ status: 'Failed', code: -1004 }));
    await expect(pay(hands().h)).rejects.toBeInstanceOf(Failed);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('switches to Phantom sending when Jupiter will not take the signed copy', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValue(done({ status: 'Failed', code: -3, error: 'Invalid message bytes' }, 400));
    const { h } = hands();
    const outcome = await pay(h);
    expect(outcome.kind).toBe('sent');
    expect(outcome.signature).toBe('sent-by-phantom');
    expect(h.sendOnly()).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    // and from then on goes straight to Phantom
    execute.mockClear();
    expect((await pay(h)).kind).toBe('sent');
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends through Phantom when it cannot sign-only', async () => {
    getOrder.mockResolvedValue(exactOut());
    const { h } = hands({ canSign: false });
    expect((await pay(h)).kind).toBe('sent');
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('reports an on-chain failure as a failure', async () => {
    getOrder.mockResolvedValue(exactOut());
    execute.mockResolvedValue(done({ status: 'Failed', code: 6001, signature: 'failed-on-chain' }));
    await expect(pay(hands().h)).rejects.toThrow(/failed on-chain \(code 6001\)/);
  });

  describe('never pays twice', () => {
    it('resends the same signed transaction after a lost request, not a new one', async () => {
      getOrder.mockResolvedValue(exactOut());
      execute.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(success);
      const { h } = hands();
      expect((await pay(h)).kind).toBe('paid');
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
    });

    it('is unconfirmed when both attempts are lost', async () => {
      getOrder.mockResolvedValue(exactOut());
      execute.mockRejectedValue(new Error('network'));
      const { h } = hands();
      expect((await pay(h)).kind).toBe('unconfirmed');
      expect(h.sign).toHaveBeenCalledTimes(1);
    });

    it('does not re-quote on an expiry code after a lost request, since the first copy may have landed', async () => {
      getOrder.mockResolvedValue(exactOut());
      execute.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(done({ status: 'Failed', code: -1 }));
      const { h } = hands();
      expect((await pay(h)).kind).toBe('unconfirmed');
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(getOrder).toHaveBeenCalledTimes(1);
    });

    it('is unconfirmed when Jupiter could not land it or does not say', async () => {
      getOrder.mockResolvedValue(exactOut());
      const replies: Execution[] = [{ status: 'Failed', code: -1000 }, { status: 'Failed', code: -1001 }, {}];
      for (const body of replies) {
        execute.mockResolvedValueOnce(done(body));
        const { h } = hands();
        expect((await pay(h)).kind).toBe('unconfirmed');
        expect(h.sign).toHaveBeenCalledTimes(1);
      }
    });

    it('never falls back to Phantom sending after a lost request', async () => {
      getOrder.mockResolvedValue(exactOut());
      execute.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(done({ status: 'Failed', code: -3 }));
      const { h } = hands();
      expect((await pay(h)).kind).toBe('unconfirmed');
      expect(h.signAndSend).not.toHaveBeenCalled();
    });
  });
});
