# sol-pay

A one-screen page for paying at a till from SOL. Open it inside Phantom or Solflare,
type a dollar amount, tap Pay, approve once. A single transaction swaps SOL to USDC and delivers the
USDC straight to a Coinbase deposit address, which funds the Coinbase debit card.

There is no backend, no API key and no RPC. The page talks only to Jupiter's public API,
and the wallet does all the signing.

## How a payment works

1. On load the page connects to the wallet (silently once the site is trusted) and fetches
   the SOL price so it can show "≈ X SOL" as you type.
2. Shortly after you stop typing it asks Jupiter for a quote in the background, so Pay
   can open the wallet without waiting.
3. On Pay it takes that quote, or a fresh one if the first is older than 4 seconds. The
   quote is ExactOut: Coinbase receives exactly the amount typed, and the SOL spent is
   capped.
4. The transaction is checked (see below). If any check fails, nothing is sent to the wallet.
5. The wallet signs. Jupiter broadcasts the signed transaction and reports the result.
6. The receipt shows the USDC delivered, the SOL spent and a Solscan link.

If Jupiter stops honouring ExactOut, the page sizes an ExactIn swap instead, so that the
guaranteed minimum output still covers the amount. If the wallet cannot sign without
sending, or Jupiter will not accept the copy it signed, the wallet sends the
transaction itself and the receipt says so.

## Wallets

Phantom and Solflare are supported (`src/wallet.ts`). Inside a wallet's own browser the
page finds that wallet and uses it. In a desktop browser with both extensions it asks
which to use, remembers the answer, and lets you change it by tapping the wallet's name
in the header. Opened where there is no wallet, it offers a link into each wallet's
browser. Any other wallet is ignored.

## Safety checks

Every quote must pass all of these before the wallet is asked to sign (`src/verify.ts`):

- It sells SOL, buys USDC, and was made for the connected wallet.
- The amount is above zero and at most `MAX_USD`.
- The transaction decodes cleanly as a v0 transaction with this wallet as the fee payer
  and only signer.
- It contains nothing but compute-budget settings, wrapping SOL, creating or closing the
  wallet's own token accounts, and one Jupiter swap. Any other instruction is refused.
- The swap's output account is the Coinbase USDC account, named in the transaction
  itself rather than through a lookup table.
- The amounts inside the swap instruction guarantee at least the amount typed.
- The SOL it can spend is within 3% of what the live price implies.
- The priority fee is at most `MAX_PRIORITY_FEE`, and no SOL goes anywhere but the swap.

After signing, the page never pays twice: if a confirmation is lost it shows
"Not confirmed" with a Solscan link instead of trying again.

## Fees

Each payment costs Solana's fixed 5,000-lamport signature fee (0.000005 SOL) plus a
priority fee that Jupiter chooses but which is capped at another 5,000 lamports.
In practice the priority fee has been a few hundred lamports. Jupiter charged no swap
fee on ExactOut quotes when this was built.

## Settings

All in `src/config.ts`:

| Constant | Meaning |
| --- | --- |
| `RECEIVER` | The Coinbase Solana USDC deposit address |
| `RECEIVER_USDC_ACCOUNT` | That address's USDC token account. A test re-derives it |
| `MAX_USD` | Hard cap per payment, in whole dollars. Currently 100 |
| `PRICE_MARGIN_BPS` | How far above the live price a payment may cost. 300 is 3% |
| `MAX_PRIORITY_FEE` | Most lamports a payment may spend on priority fee |

To change the cap, edit `MAX_USD`, run `npm test`, and deploy. If `RECEIVER` changes,
`RECEIVER_USDC_ACCOUNT` must change with it, and `npm test` fails until it does.

## Working on it

```bash
npm install
npm run dev     # the page with a pretend wallet, at http://localhost:5173
npm test        # amount parsing, sizing maths, safety checks, payment flow
npm run build   # production build in dist/
```

`npm run dev` adds a "Simulate" menu for walking through every outcome without a wallet
or money, for either wallet or both: success, a rejected signature, an expired quote, each kind of refusal, a lost
confirmation, and so on. "Live Jupiter quotes" uses real quotes and fakes only the send.
None of that code is in the production build.

Adding `?debug` to the URL shows a running log on screen: what the wallet offered, which
signing path was used, and what Jupiter answered. Useful for the first run on a phone.

## Deploying

The repo deploys as it is on Cloudflare or Netlify. On every host the build command is
`npm run build` and the output directory is `dist`.

| Host | What reads what |
| --- | --- |
| Cloudflare Workers | `wrangler.jsonc` points at `dist`. Deploy command: `npx wrangler deploy` |
| Cloudflare Pages | Set the build command and output directory in the dashboard |
| Netlify | `netlify.toml` holds the build settings |

To deploy to Cloudflare by hand, run `npx wrangler login` once, then `npm run deploy`.
It uses the version of Wrangler pinned in `package-lock.json`, not whatever is newest.
`npm run fingerprint` prints the SHA-256 of every file the site serves, for checking a
deployment against the build.

The security headers are in `public/_headers`, a format all three read. The
Content-Security-Policy allows the page's own files and `https://api.jup.ag` only.

If the page ever shows "No wallet found" while open inside a wallet's browser, the policy
is the first thing to check: it would mean the wallet injects itself in a way the policy
blocks.

## The iOS Shortcut

A Shortcut opens the wallet's in-app browser on the page with a browse deeplink, one
Shortcut per wallet:

```
https://phantom.com/ul/browse/<URL-encoded page address>?ref=<URL-encoded page address>
https://solflare.com/ul/v1/browse/<URL-encoded page address>?ref=<URL-encoded page address>
```

For a site at `https://example.netlify.app` that is:

```
https://phantom.com/ul/browse/https%3A%2F%2Fexample.netlify.app?ref=https%3A%2F%2Fexample.netlify.app
```

## One thing to leave alone

Keep the empty USDC token account in the paying wallet. Jupiter's transaction refers to
it even though no USDC is put there, and recreates it (about 0.0015 SOL) if it is missing.
