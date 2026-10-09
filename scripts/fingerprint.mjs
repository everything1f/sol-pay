// Prints the SHA-256 of every file the live site serves, from the local build.
// Run `npm run build` first. The watchdog on the VPS compares the live site
// against these, so after a deploy this is the list to check its report against.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

const rows = [];
for await (const path of files(dist)) {
  const name = relative(dist, path).replaceAll('\\', '/');
  if (name === '_headers') continue; // read by the host, never served
  const url = name === 'index.html' ? '/' : `/${name}`;
  rows.push([url, createHash('sha256').update(await readFile(path)).digest('hex')]);
}
rows.sort(([a], [b]) => a.localeCompare(b));
for (const [url, hash] of rows) console.log(`${hash}  ${url}`);
