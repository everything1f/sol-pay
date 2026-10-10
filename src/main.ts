import './style.css';
import { formatSol, formatUnits, formatUsdc, press, toUnits, type Key } from './amount';
import { shorten } from './base58';
import { MAX_UNITS, MAX_USD, RECEIVER } from './config';
import { getPrice, Unreachable } from './jupiter';
import { Failed, pay, quote, type Outcome, type Phase, type Quote } from './pay';
import { lamportsFor, priceUnits } from './sizing';
import { Refusal } from './verify';
import * as wallet from './wallet';

// The pretend wallet and pretend Jupiter exist only under `npm run dev`.
if (import.meta.env.DEV) (await import('./dev/mock')).install();

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = el('app');
const tag = el('tag');
const whole = el('whole');
const cents = el('cents');
const ghost = el('ghost');
const sol = el('sol');
const note = el('note');
const pad = el('pad');
const payButton = el<HTMLButtonElement>('pay');
const chooser = el('choose');
const who = el<HTMLButtonElement>('who');
const sum = el('sum');
const slip = el('slip');
const log = el('log');

// looking: waiting for a wallet to appear. absent: none on this page. choose: more than
// one, and none picked yet. ask: picked but not connected. ready: connected.
type Link = 'looking' | 'absent' | 'choose' | 'ask' | 'ready';
const LINK_TEXT: Record<Link, string> = {
  looking: 'Connecting',
  absent: 'No wallet found',
  choose: 'Choose a wallet',
  ask: 'Not connected',
  ready: '',
};

let link: Link = 'looking';
/** The wallet in use: the only one present, or the one picked. */
let kind: wallet.Kind | undefined;
let address: string | undefined;
let value = '';
let busy: Phase | undefined;
let done = false;
let price: { units: bigint; at: number } | undefined;
let warm: { taker: string; units: bigint; quote: Promise<Quote> } | undefined;
let warmTimer = 0;
let holdTimer = 0;

// ?debug shows a running log on screen, for the first run inside a wallet on a phone.
const debugging = new URLSearchParams(location.search).has('debug');
log.hidden = !debugging;
function trace(line: string): void {
  if (debugging) log.textContent += `${line}\n`;
}

// Two small things are remembered between visits, neither of them sensitive.
const memory = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private browsing: nothing is kept, and the page asks again next time */
    }
  },
};

// That Jupiter refused a transaction signed by this wallet, so later payments let
// the wallet send instead. Kept per wallet; Phantom keeps its original key.
const sendOnlyKey = () => (!kind || kind.id === 'phantom' ? 'send-only' : `send-only-${kind.id}`);
const sendOnly = {
  get: () => memory.get(sendOnlyKey()) === '1',
  set: () => memory.set(sendOnlyKey(), '1'),
};

// Which wallet was picked last, for a browser that has more than one.
const lastPick = {
  get: () => memory.get('wallet'),
  set: (id: string) => memory.set('wallet', id),
};

/* Drawing */

const glyphs: HTMLElement[] = [];

/** Adds or removes digits at the end, so only a new digit animates in. */
function showValue(): void {
  let same = 0;
  while (same < glyphs.length && same < value.length && glyphs[same].textContent === value[same]) same++;
  while (glyphs.length > same) glyphs.pop()!.remove();
  const dot = value.indexOf('.');
  for (let i = same; i < value.length; i++) {
    const glyph = document.createElement('i');
    glyph.textContent = value[i];
    (dot >= 0 && i >= dot ? cents : whole).append(glyph);
    glyphs.push(glyph);
  }
  ghost.hidden = value !== '';
  tag.setAttribute('aria-label', value ? `${value} dollars` : 'No amount');
}

function setWords(text: string): void {
  const current = el('words');
  if (current.textContent === text) return;
  // A fresh element, so the entrance animation plays for each new label.
  const next = current.cloneNode() as HTMLElement;
  next.textContent = text;
  current.replaceWith(next);
}

function render(): void {
  app.dataset.state = done ? 'done' : busy ? 'busy' : 'entry';
  app.dataset.phase = busy ?? '';
  // With one wallet the header shows the address alone, as it always has. With several
  // it names the wallet too, and tapping it goes back to the choice.
  const here = wallet.available();
  const several = here.length > 1;
  who.textContent =
    link === 'ready' && address && kind ? `${several ? `${kind.name} ` : ''}${shorten(address)}` : LINK_TEXT[link];
  who.classList.toggle('on', link === 'ready');
  who.disabled = !several || !kind || !!busy || done;
  if (who.disabled) who.removeAttribute('title');
  else who.title = 'Change wallet';

  const units = toUnits(value);
  if (units > 0n && price) sol.textContent = `≈ ${formatSol(lamportsFor(units, price.units))} SOL`;
  else if (price) sol.textContent = `1 SOL = $${formatUnits(price.units, 6, 2)}`;
  else sol.textContent = ' ';

  // Without a wallet, or with a choice still to make, the Pay bar gives way to one
  // button per wallet: "open in" when none is here, the wallet's name when several are.
  const picking = !busy && !done && (link === 'absent' || link === 'choose');
  chooser.hidden = !picking;
  payButton.hidden = picking;
  for (const option of chooser.querySelectorAll('button')) {
    const name = wallet.supported.find((k) => k.id === option.dataset.wallet)?.name ?? '';
    option.textContent = link === 'absent' ? `Open in ${name}` : name;
    option.hidden = link === 'choose' && !here.some((k) => k.id === option.dataset.wallet);
  }

  const name = kind?.name ?? 'wallet';
  let words = 'Pay';
  let amount = '';
  let enabled = false;
  if (busy) {
    words = busy === 'quoting' ? 'Getting quote' : busy === 'awaiting' ? `Approve in ${name}` : 'Sending';
    enabled = true; // stays lit while it reports progress; taps are ignored
  } else if (link === 'ask') {
    words = `Connect ${name}`;
    enabled = true;
  } else {
    amount = units > 0n ? `$${formatUnits(units, 6, 2)}` : '';
    enabled = link === 'ready' && units > 0n;
  }
  setWords(words);
  sum.textContent = amount;
  payButton.disabled = !enabled;
  payButton.setAttribute('aria-busy', String(!!busy));
}

function say(text: string): void {
  note.textContent = text;
}

/** A small sideways nudge of the amount: this key was not accepted. */
function nudge(): void {
  tag.classList.remove('nudge');
  void tag.offsetWidth; // restart the animation
  tag.classList.add('nudge');
}

/* Keypad */

function tap(key: Key): void {
  if (busy || done) return;
  const pressed = press(value, key, MAX_UNITS);
  if (pressed.rejected) {
    if (pressed.rejected === 'empty') return;
    say(pressed.rejected === 'max' ? `The limit is $${MAX_USD} per payment.` : '');
    nudge();
    return;
  }
  value = pressed.value;
  say('');
  showValue();
  render();
  warmUp();
}

function clearAll(): void {
  if (busy || done || !value) return;
  value = '';
  say('');
  showValue();
  render();
  warmUp();
}

pad.addEventListener('pointerdown', (event) => {
  const key = (event.target as Element).closest('button');
  if (!key) return;
  event.preventDefault(); // act on touch-down, and keep focus rings for the keyboard
  key.classList.add('down');
  tap(key.dataset.key as Key);
  if (key.dataset.key === 'back') holdTimer = window.setTimeout(clearAll, 450);
});

// Keyboard and assistive activation arrive as a click with no pointer behind it.
pad.addEventListener('click', (event) => {
  const key = (event.target as Element).closest('button');
  if (key && event.detail === 0) tap(key.dataset.key as Key);
});

payButton.addEventListener('pointerdown', () => payButton.classList.add('down'));

function release(): void {
  clearTimeout(holdTimer);
  for (const pressed of document.querySelectorAll('.down')) pressed.classList.remove('down');
}
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);
pad.addEventListener('contextmenu', (event) => event.preventDefault());

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (/^[0-9.]$/.test(event.key)) tap(event.key as Key);
  else if (event.key === 'Backspace') tap('back');
  else if (event.key === 'Enter' && document.activeElement === document.body) void onPay();
});

/* Price */

async function refreshPrice(): Promise<bigint> {
  price = { units: priceUnits(await getPrice()), at: Date.now() };
  render();
  return price.units;
}

/** A price no older than 30 seconds, fetching one if need be. */
async function livePrice(): Promise<bigint> {
  return price && Date.now() - price.at < 30_000 ? price.units : refreshPrice();
}

function keepPriceFresh(): void {
  const stale = () => !price || Date.now() - price.at > 15_000;
  const tick = () => {
    if (!document.hidden && !busy && !done && stale()) refreshPrice().catch(() => {});
  };
  tick();
  setInterval(tick, 5_000);
  document.addEventListener('visibilitychange', tick);
}

/* Quote ahead: once the amount settles, fetch and check a quote so Pay can open the wallet at once. */

function warmUp(): void {
  clearTimeout(warmTimer);
  warm = undefined;
  const taker = address;
  const units = toUnits(value);
  if (link !== 'ready' || !taker || units <= 0n) return;
  warmTimer = window.setTimeout(() => {
    const pending = livePrice().then((p) => quote(taker, units, p));
    pending.catch(() => {}); // any problem is reported when Pay is pressed
    warm = { taker, units, quote: pending };
  }, 600);
}

/* Wallet */

async function connect(silent: boolean): Promise<void> {
  const using = kind;
  if (!using) return;
  try {
    const found = await wallet.connect(using, silent);
    if (kind !== using) return; // a different wallet was picked while this one was answering
    address = found;
    link = 'ready';
    trace(`connected ${using.name} ${address}`);
    const offers = await wallet.abilities(using, address);
    trace(`${using.name} offers ${JSON.stringify(offers)}`);
    // If this wallet needs the older signing API, fetch that code now rather than on Pay.
    if (!offers.standardSign || !offers.standardSend) wallet.prepareLegacy();
  } catch (error) {
    if (kind !== using) return;
    link = 'ask';
    if (!silent && !(error instanceof wallet.Rejected)) say(`${using.name} could not connect: ${text(error)}`);
  }
  render();
  warmUp();
}

const watched = new Set<string>();
const isReady = (): boolean => link === 'ready';

/** Starts using a wallet: connects without a prompt if the site is already trusted, otherwise asks. */
async function use(next: wallet.Kind): Promise<void> {
  kind = next;
  address = undefined;
  link = 'looking';
  lastPick.set(next.id);
  render();
  if (!watched.has(next.id)) {
    watched.add(next.id);
    wallet.onAccountChange(next, (changed) => {
      if (kind !== next) return; // news from a wallet that is no longer the one in use
      address = changed;
      link = changed ? 'ready' : 'ask';
      render();
      warmUp();
    });
  }
  await connect(true);
  // First visit: the wallet asks to trust the site once.
  if (kind === next && !isReady()) await connect(false);
}

async function findWallet(): Promise<void> {
  // A wallet injects before the page runs. If none is here, say so almost at once,
  // but keep looking for a few seconds in case a browser extension is slow to load.
  let found = wallet.available();
  for (let i = 0; !found.length; i++) {
    if (i === 2) {
      link = 'absent';
      trace('no wallet on this page');
      render();
    }
    if (i === 40) return;
    await new Promise((r) => setTimeout(r, 100));
    found = wallet.available();
  }
  // Inside a wallet's own browser there is exactly one. A computer may have both
  // extensions: use the one picked last time, or ask.
  const pick = found.length === 1 ? found[0] : found.find((k) => k.id === lastPick.get());
  if (pick) return use(pick);
  link = 'choose';
  render();
}

chooser.addEventListener('click', (event) => {
  const option = (event.target as Element).closest('button');
  const picked = wallet.supported.find((k) => k.id === option?.dataset.wallet);
  if (!picked) return;
  if (link === 'absent') location.href = wallet.browseLink(picked, location.href, location.origin);
  else void use(picked);
});

// The wallet's name in the header: back to the choice.
who.addEventListener('click', () => {
  if (who.disabled) return;
  clearTimeout(warmTimer);
  warm = undefined;
  kind = undefined;
  address = undefined;
  link = 'choose';
  say('');
  render();
});

/* Pay */

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function explain(error: unknown): string {
  if (error instanceof Refusal) return `Refused to sign: ${error.message}. Nothing was sent.`;
  if (error instanceof Failed) return error.message;
  if (error instanceof Unreachable) return `${error.message} Nothing was sent.`;
  return `That did not go through: ${text(error)}`;
}

async function onPay(): Promise<void> {
  if (busy || done) return;
  if (link === 'ask') return connect(false);

  const using = kind;
  const taker = address;
  const units = toUnits(value);
  if (link !== 'ready' || !using || !taker || units <= 0n) return;

  clearTimeout(warmTimer);
  const ready = warm && warm.taker === taker && warm.units === units ? warm.quote : undefined;
  warm = undefined;
  say('');
  const phase = (next: Phase) => {
    busy = next;
    render();
  };
  phase('quoting');

  try {
    const offers = await wallet.abilities(using, taker);
    const outcome = await pay({
      taker,
      units,
      warm: ready,
      price: livePrice,
      phase,
      canSign: offers.standardSign || offers.providerSign,
      sign: (transaction) => wallet.sign(using, taker, transaction),
      signAndSend: (transaction) => wallet.signAndSend(using, taker, transaction),
      sendOnly: () => wallet.sendsItself(using) || sendOnly.get(),
      rememberSendOnly: sendOnly.set,
      trace,
    });
    busy = undefined;
    showSlip(outcome);
  } catch (error) {
    busy = undefined;
    trace(`stopped: ${text(error)}`);
    // Dismissing the wallet's prompt is not an error: back to the keypad, amount intact.
    if (!(error instanceof wallet.Rejected)) say(explain(error));
    render();
  }
}

payButton.addEventListener('click', () => void onPay());

/* Receipt */

function showSlip(outcome: Outcome): void {
  const paid = outcome.kind === 'paid';
  slip.dataset.kind = outcome.kind;
  const name = kind?.name ?? 'The wallet';
  el('slipTitle').textContent = paid ? 'Paid' : outcome.kind === 'sent' ? `Sent by ${name}` : 'Not confirmed';
  el('slipNote').textContent = paid
    ? ''
    : outcome.kind === 'sent'
      ? `${name} submitted this one, so this page cannot watch it land. Solscan shows the result.`
      : 'It was submitted, but no confirmation came back. Check Solscan before paying again.';
  el('usdcLabel').textContent = paid ? 'USDC delivered' : 'USDC to deliver';
  el('solLabel').textContent = paid ? 'SOL spent' : 'SOL, at most';
  el('outUsdc').textContent = formatUsdc(outcome.usdc);
  el('outSol').textContent = formatSol(outcome.lamports, 6);
  const transaction = el<HTMLAnchorElement>('outTx');
  transaction.textContent = shorten(outcome.signature);
  transaction.href = `https://solscan.io/tx/${outcome.signature}`;
  slip.setAttribute('aria-hidden', 'false');
  done = true;
  render();
}

el('again').addEventListener('click', () => {
  done = false;
  value = '';
  slip.setAttribute('aria-hidden', 'true');
  showValue();
  render();
});

/* Start */

el('dest').textContent = el('slipDest').textContent = shorten(RECEIVER);
showValue();
render();
keepPriceFresh();
void findWallet();
