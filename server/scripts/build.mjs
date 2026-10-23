// Bundle src/index.ts (+ hono) into one ESM file: dist/index.js.
// node:* built-ins (incl. node:sqlite) stay external, so no node_modules is
// needed at runtime.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
// Mark dist/ as ESM so `node dist/index.js` works without the root package.json.
await mkdir('dist', { recursive: true });
await writeFile('dist/package.json', '{"type":"module"}\n');
