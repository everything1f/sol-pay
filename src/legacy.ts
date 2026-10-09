// Loaded only when Phantom lacks Wallet Standard signing. Its older provider API
// takes a web3.js transaction object rather than bytes, so this is the one place
// that library is used. It builds into its own file and is fetched on demand.

import { VersionedTransaction } from '@solana/web3.js';

export const toVersioned = (bytes: Uint8Array) => VersionedTransaction.deserialize(bytes);
