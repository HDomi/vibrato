import { cpSync, readFile } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * pdf.js fetches its runtime assets by URL at run time: CMaps (required for CJK text, which otherwise
 * renders with no glyphs and no error), standard fonts, wasm image decoders and ICC profiles. A
 * bundler cannot rewrite directory URLs, so they are served from `/pdfjs/` in dev and copied into the
 * build output. See web/src/lib/pdfRender.ts.
 */
function pdfjsAssets(): Plugin {
  const src = fileURLToPath(new URL('./node_modules/pdfjs-dist', import.meta.url));
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  let outDir = '';
  return {
    name: 'pdfjs-assets',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = path.join(src, rel);
        if (!dirs.includes(rel.split('/')[1]) || !file.startsWith(src + path.sep)) return next();
        readFile(file, (err, data) => (err ? next() : res.end(data)));
      });
    },
    writeBundle() {
      for (const d of dirs) cpSync(path.join(src, d), path.join(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:11398',
      '/ws': { target: 'ws://127.0.0.1:11398', ws: true },
      '/pty': { target: 'ws://127.0.0.1:11398', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep the ~1200 theme icons as files instead of inlining them into the bundle.
    assetsInlineLimit: (file) => (file.includes('material-icon-theme') ? false : undefined),
  },
});
