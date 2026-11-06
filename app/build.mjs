// Build the app into dist/: app.js and app.css (esbuild), plus the files in
// public/. The web service serves dist/ at /-/app/ (SPACEHUB_APP_DIR).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--dev');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
await build({
  // shell.css also on its own: the server-rendered pages link it for the same frame.
  entryPoints: { app: 'src/main.tsx', shell: 'src/shell.css' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  outdir: 'dist',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'warning',
});
cpSync('public', 'dist', { recursive: true });
