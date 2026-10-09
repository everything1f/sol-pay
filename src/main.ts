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
const sum = el('sum');
const slip = el('slip');
const log = el('log');

type Link = 'looking' | 'absent' | 'ask' | 'ready';
const LINK_TEXT: Record<Link, string> = {
  looking: 'Connecting',
  absent: 'Phantom not found',
  ask: 'Not connected',
  ready: '',
};
const PHASE_TEXT: Record<Phase, string> = {
  quoting: 'Getting quote',
  awaiting: 'Approve in Phantom',
  sending: 'Sending',
};

let link: Link = 'looking';
let address: string | undefined;
let value = '';
let busy: Phase | undefined;
let done = false;
let price: { units: bigint; at: number } | undefined;
let warm: { taker: string; units: bigint; quote: Promise<Quote> } | undefined;
let warmTimer = 0;
let holdTimer = 0;

// ?debug shows a running log on screen, for the first run inside Phantom on a phone.
const debugging = new URLSearchParams(location.search).has('debug');
log.hidden = !debugging;
function trace(line: string): void {
  if (debugging) log.textContent += `${line}\n`;
}

// Remembers one thing: that Jupiter refused a transaction signed by this Phantom,
// so later payments let Phantom send instead. Nothing sensitive is stored.
const sendOnly = {
  get: () => {
    try {
      return localStorage.getItem('send-only') === '1';
    } catch {
      return false;
    }
  },
  set: () => {
    try {
      localStorage.setItem('send-only', '1');
    } catch {
      /* private browsing: fall back to asking again next time */
    }
  },
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
  const who = el('who');
  who.textContent = link === 'ready' && address ? shorten(address) : LINK_TEXT[link];
  who.classList.toggle('on', link === 'ready');

  const units = toUnits(value);
  if (units > 0n && price) sol.textContent = `≈ ${formatSol(lamportsFor(units, price.units))} SOL`;
  else if (price) sol.textContent = `1 SOL = $${formatUnits(price.units, 6, 2)}`;
  else sol.textContent = ' ';

  let words = 'Pay';
  let amount = '';
  let enabled = false;
  if (busy) {
    words = PHASE_TEXT[busy];
    enabled = true; // stays lit while it reports progress; taps are ignored
  } else if (link === 'absent') {
    words = 'Open in Phantom';
    enabled = true;
  } else if (link === 'ask') {
    words = 'Connect Phantom';
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

/* Quote ahead: once the amount settles, fetch and check a quote so Pay can open Phantom at once. */

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
  try {
    address = await wallet.connect(silent);
    link = 'ready';
    trace(`connected ${address}`);
    const offers = await wallet.abilities(address);
    trace(`phantom offers ${JSON.stringify(offers)}`);
    // If this Phantom needs the older signing API, fetch that code now rather than on Pay.
    if (!offers.standardSign || !offers.standardSend) wallet.prepareLegacy();
  } catch (error) {
    link = 'ask';
    if (!silent && !(error instanceof wallet.Rejected)) say(`Phantom could not connect: ${text(error)}`);
  }
  render();
  warmUp();
}

async function findWallet(): Promise<void> {
  // Phantom injects before the page runs. If it is missing, say so almost at once,
  // but keep looking for a few seconds in case a browser extension is slow to load.
  for (let i = 0; !wallet.provider(); i++) {
    if (i === 2) {
      link = 'absent';
      trace('no Phantom provider on this page');
      render();
    }
    if (i === 40) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  wallet.onAccountChange((next) => {
    address = next;
    link = next ? 'ready' : 'ask';
    render();
    warmUp();
  });
  await connect(true);
  if (link !== 'ready') await connect(false); // first visit: Phantom asks to trust the site once
}

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
  if (link === 'absent') {
    const here = encodeURIComponent(location.href);
    location.href = `https://phantom.com/ul/browse/${here}?ref=${encodeURIComponent(location.origin)}`;
    return;
  }
  if (link === 'ask') return connect(false);

  const taker = address;
  const units = toUnits(value);
  if (link !== 'ready' || !taker || units <= 0n) return;

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
    const offers = await wallet.abilities(taker);
    const outcome = await pay({
      taker,
      units,
      warm: ready,
      price: livePrice,
      phase,
      canSign: offers.standardSign || offers.providerSign,
      sign: (transaction) => wallet.sign(taker, transaction),
      signAndSend: (transaction) => wallet.signAndSend(taker, transaction),
      sendOnly: sendOnly.get,
      rememberSendOnly: sendOnly.set,
      trace,
    });
    busy = undefined;
    showSlip(outcome);
  } catch (error) {
    busy = undefined;
    trace(`stopped: ${text(error)}`);
    // Dismissing Phantom's prompt is not an error: back to the keypad, amount intact.
    if (!(error instanceof wallet.Rejected)) say(explain(error));
    render();
  }
}

payButton.addEventListener('click', () => void onPay());

/* Receipt */

function showSlip(outcome: Outcome): void {
  const paid = outcome.kind === 'paid';
  slip.dataset.kind = outcome.kind;
  el('slipTitle').textContent = paid ? 'Paid' : outcome.kind === 'sent' ? 'Sent by Phantom' : 'Not confirmed';
  el('slipNote').textContent = paid
    ? ''
    : outcome.kind === 'sent'
      ? 'Phantom submitted this one, so this page cannot watch it land. Solscan shows the result.'
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
