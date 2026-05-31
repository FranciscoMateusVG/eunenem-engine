/**
 * Barrel-export evaluation smoke test (aperture-3chj2).
 *
 * **The gap this closes:** `pnpm typecheck` (tsc --noEmit) does NOT
 * actually evaluate the import graph at runtime. If a file does
 * `import { ArrecadacaoLimiteOpcaoExcedidoError } from '../../src/index.js'`
 * but the barrel never re-exports that binding, tsc will sometimes pass
 * (if the binding does NOT exist in the source module either, you get a
 * compile error; but if the binding exists in the source module and is
 * just missing from the barrel re-export list, tsc through the barrel
 * doesn't catch it because it sees the value-import as "type-only via
 * implicit re-export" and resolves through the file system, not the
 * declared export list).
 *
 * `pnpm test` doesn't catch it either if no test exercises the import
 * path. The first thing that catches it is `tsx server.tsx` at runtime
 * — Node's module evaluator THROWS:
 *
 *     SyntaxError: The requested module '../../src/index.js' does not
 *     provide an export named 'ArrecadacaoLimiteOpcaoExcedidoError'
 *
 * Banked precedent (aperture-d6atj, 2026-05-30): PR #68 added that exact
 * import without the matching re-export. `pnpm check` passed. The dev
 * server crashed on boot. GLaDOS hotfixed the export on staging.
 *
 * **How this script catches it:** `import * as barrel from '../src/index.js'`
 * forces Node's ESM evaluator to walk the full re-export chain in the
 * barrel module. Any `export { Foo } from './bar.js'` where `Foo` doesn't
 * actually exist in `./bar.js` throws at evaluation time. The script
 * fails fast, the pre-push hook blocks the push, the regression never
 * lands.
 *
 * **Why not just import the barrel in a test file?** A test would only
 * catch it if the test runner actually evaluates the import (vitest with
 * dynamic import skipping, or "test file existed but no test ran" could
 * silently pass). A dedicated script that's explicitly part of `pnpm
 * check` removes that ambiguity — the script either runs cleanly or
 * fails the build.
 *
 * **Why not depcruise?** depcruise validates the import graph
 * statically (architectural rules — domain can't import adapters, etc).
 * It doesn't evaluate whether re-exported bindings actually exist at the
 * destination module — same blind spot as tsc.
 *
 * **Scope caveat — barrel-internal vs consumer-side:** this script
 * catches the case where `src/index.ts` itself re-exports a binding that
 * does NOT exist in the source module. It does NOT catch the case where
 * a CONSUMER file (e.g. apps/eunenem-server/server/trpc/contribuicao-router.ts)
 * imports `{ Foo } from '../../src/index.js'` when the barrel doesn't
 * provide `Foo`. The original aperture-d6atj footgun was actually the
 * consumer-side variant. Catching THAT requires the consumer's own
 * check (apps/eunenem-server would need an equivalent script that
 * imports its own entry-tree). Filed as follow-up if needed.
 *
 * This script still closes a real gap — barrel-internal drift (someone
 * adds an `export { X } from './foo.js'` line referencing a binding
 * that was renamed or removed in ./foo.js) crashes at boot today and
 * gets caught at PR-time now.
 */
import * as barrel from '../src/index.js';

const exportCount = Object.keys(barrel).length;
if (exportCount === 0) {
  console.error('❌ Barrel exports 0 bindings — src/index.ts is empty or broken.');
  process.exit(1);
}
console.log(`✅ Barrel exports: ${exportCount} bindings resolved cleanly.`);
