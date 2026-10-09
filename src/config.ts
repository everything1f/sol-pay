/** Where every payment goes: the Coinbase Solana USDC deposit address. */
export const RECEIVER = 'EuidZES2ny7rGKxFfQfQh2hyQBpSZPQXgj37WJwLVNvU';

/** RECEIVER's USDC token account. test/config.test.ts re-derives it from RECEIVER. */
export const RECEIVER_USDC_ACCOUNT = '6BUf9sYWb3AmoPNS18ibu8XgCWKgTkLAoxuyYN4gFGMF';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Hard cap per payment, in whole dollars. */
export const MAX_USD = 100;

/** The cap in USDC base units (6 decimals). */
export const MAX_UNITS = BigInt(MAX_USD) * 1_000_000n;

/** A payment may take at most this much more SOL than the live price implies. */
export const PRICE_MARGIN_BPS = 300n;

/**
 * The most a payment may spend on priority fee, in lamports (0.000005 SOL).
 * Jupiter is told to stay under it, and a transaction that exceeds it is refused.
 * This is on top of Solana's fixed 5,000-lamport signature fee, which nothing can waive.
 */
export const MAX_PRIORITY_FEE = 5_000n;

/** A quote fetched while typing is reused on Pay only if it is younger than this. */
export const WARM_QUOTE_MS = 8_000;

export const JUPITER = 'https://api.jup.ag';
