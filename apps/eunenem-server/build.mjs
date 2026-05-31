import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

async function buildClient() {
  const opts = {
    entryPoints: ['client.tsx'],
    bundle: true,
    outfile: 'public/client.js',
    format: 'esm',
    target: ['es2022'],
    jsx: 'automatic',
    minify: !watch,
    sourcemap: watch,
    logLevel: 'info',
    tsconfig: './tsconfig.json',
    // aperture-xaha2: inline STRIPE_PUBLISHABLE_KEY into the client bundle
    // so `loadStripe(import.meta.env...)` / `loadStripe(process.env...)`
    // resolves to the real test-mode publishable key at build time. The
    // SECRET_KEY and WEBHOOK_SECRET intentionally STAY server-only — they
    // are never referenced in client.tsx and never appear in this define
    // block. If `STRIPE_PUBLISHABLE_KEY` is unset at build time, an empty
    // string is inlined; the embedded checkout call will fail at runtime
    // with a clear Stripe error rather than silently breaking.
    define: {
      'process.env.STRIPE_PUBLISHABLE_KEY': JSON.stringify(
        process.env.STRIPE_PUBLISHABLE_KEY ?? '',
      ),
    },
  };

  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('[esbuild] watching client.tsx');
  } else {
    await esbuild.build(opts);
    console.log('[esbuild] built public/client.js');
  }
}

function buildTailwind() {
  return new Promise((resolve, reject) => {
    const args = ['-i', 'tailwind.css', '-o', 'public/styles.css'];
    if (watch) args.push('--watch');
    if (!watch) args.push('--minify');

    const child = spawn('./node_modules/.bin/tailwindcss', args, {
      stdio: 'inherit',
    });

    if (watch) {
      // In watch mode, leave it running; resolve immediately so concurrently sees us as live.
      resolve();
    } else {
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tailwind exit ${code}`))));
    }
  });
}

await Promise.all([buildClient(), buildTailwind()]);
