// Cuts the two typefaces down to the characters the page draws and writes them to
// src/assets, where the build inlines them into the stylesheet (no font requests).
// Run with `npm run font` after changing a face, a weight or the character sets.
import { readFile, writeFile } from 'node:fs/promises';
import subsetFont from 'subset-font';

const NUMERALS = '0123456789$.,';
// Printable ASCII plus the few extras the interface uses.
const WORDS =
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') + '…≈–—’‘“”';

const JOBS = [
  { face: 'big-shoulders-display', weight: 700, glyphs: NUMERALS, out: 'numerals.woff2' },
  { face: process.argv[2] ?? 'barlow-semi-condensed', weight: 500, glyphs: WORDS, out: 'words-500.woff2' },
  { face: process.argv[2] ?? 'barlow-semi-condensed', weight: 600, glyphs: WORDS, out: 'words-600.woff2' },
];

for (const { face, weight, glyphs, out } of JOBS) {
  const source = new URL(
    `../node_modules/@fontsource/${face}/files/${face}-latin-${weight}-normal.woff2`,
    import.meta.url,
  );
  const subset = await subsetFont(await readFile(source), glyphs, { targetFormat: 'woff2' });
  await writeFile(new URL(`../src/assets/${out}`, import.meta.url), subset);
  console.log(`${out.padEnd(18)} ${face} ${weight}, ${subset.length} bytes`);
}
