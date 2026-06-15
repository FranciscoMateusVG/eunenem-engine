/**
 * aperture-7iik6 — server-side router resolution smoke.
 *
 * Bug class this defends against: server-side module-resolution drift
 * (relative-import-depth bugs that esbuild's client bundle hides but
 * tsx watch / native Node ESM surfaces at boot). Precedent:
 * aperture-erdid 2026-06-10 — painel-mensagens-router shipped with
 * 3-deep `../../../src/...` imports while siblings used 4-deep
 * `../../../../src/...`; esbuild bundled cleanly, tsx watch crashed
 * on boot with `Cannot find module`. Typecheck passed because
 * TypeScript path-resolves through tsconfig + node-walk and found
 * the targets; Node ESM resolves the literal path and didn't.
 *
 * Strategy: dynamic-import every server-side router via tsx, which
 * uses the same Node ESM resolver as `tsx watch` in prod dev. If a
 * router has broken relative paths (or a missing transitive import,
 * or a renamed file someone forgot to update), this throws here at
 * CI time with a useful error naming the file.
 *
 * Scope: only the trpc router files. Their transitive closure
 * exercises src/use-cases/, src/adapters/, src/domain/, src/errors/
 * — the entire engine-domain surface the routers talk to. Deeper
 * server-side files (server.tsx, setup.ts, webhooks) intentionally
 * skipped because they have boot-time side effects (loadEnv,
 * buildServerDeps) that require a real env; the smoke is about
 * MODULE RESOLUTION, not runtime config validation.
 *
 * Cost: ~2s on a warm pnpm install. No DB, no port binding, no
 * network. Runs in the existing pre-push `pnpm check` chain.
 */

import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROUTERS_DIR = resolve(import.meta.dirname, '..', 'apps', 'eunenem-server', 'server', 'trpc');

interface CheckResult {
  readonly file: string;
  readonly status: 'ok' | 'fail';
  readonly error?: string;
}

async function listRouterFiles(): Promise<string[]> {
  const entries = await fs.readdir(ROUTERS_DIR);
  return entries
    .filter((name) => name.endsWith('.ts'))
    // router.ts is the root; the *-router.ts files are the leaves.
    // Both go through resolution so we cover all of them.
    .filter((name) => name === 'router.ts' || name.endsWith('-router.ts'))
    .map((name) => join(ROUTERS_DIR, name))
    .sort();
}

async function checkOne(absPath: string): Promise<CheckResult> {
  const file = relative(process.cwd(), absPath);
  try {
    const url = pathToFileURL(absPath).href;
    const mod = await import(url);
    // Defensive: confirm the module evaluated to a non-empty namespace.
    // A module that resolves but exports nothing is a smell — likely
    // means a circular import dropped the named export.
    if (Object.keys(mod).length === 0) {
      return {
        file,
        status: 'fail',
        error: 'module evaluated but exports are empty (possible circular import)',
      };
    }
    return { file, status: 'ok' };
  } catch (err) {
    return {
      file,
      status: 'fail',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const files = await listRouterFiles();
  if (files.length === 0) {
    console.error('no router files found under', ROUTERS_DIR);
    process.exit(2);
  }

  const results: CheckResult[] = [];
  for (const f of files) {
    const r = await checkOne(f);
    results.push(r);
  }

  const failures = results.filter((r) => r.status === 'fail');
  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`  ok  ${r.file}`);
    } else {
      console.error(`  FAIL ${r.file}`);
      console.error(`       ${r.error}`);
    }
  }

  const elapsed = Date.now() - start;
  console.log('');
  console.log(`server-router resolution smoke: ${results.length - failures.length}/${results.length} ok in ${elapsed}ms`);

  if (failures.length > 0) {
    console.error('');
    console.error(
      'One or more server-side routers failed to load via the Node ESM resolver.',
    );
    console.error(
      'Common cause: relative-import-depth drift (e.g. ../../../src vs ../../../../src).',
    );
    console.error(
      'TypeScript can resolve through tsconfig + node-walk; Node ESM resolves the literal path.',
    );
    console.error(
      'Compare the failing file\'s `../../../*` imports against a sibling router\'s shape.',
    );
    process.exit(1);
  }
}

void main();
