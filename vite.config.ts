import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // Large enough to inline the fonts into the stylesheet: one request, no font swap.
    assetsInlineLimit: 48 * 1024,
    // No inline scripts, so the Content-Security-Policy can forbid them.
    modulePreload: { polyfill: false },
  },
  server: { port: 5173, strictPort: true },
});
