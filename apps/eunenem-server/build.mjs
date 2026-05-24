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
