import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';

const hooksDir = join(import.meta.dirname, '..', '.husky');
// Only pre-commit (lint-staged). The pre-push hook was removed on purpose in
// b4bde53 (operator decision 2026-08-01): it duplicated CI and hung whenever
// the local Docker daemon was down. CI (.github/workflows/ci.yml) is the gate.
const requiredHooks = ['pre-commit'];
let failed = false;

for (const hook of requiredHooks) {
  const hookPath = join(hooksDir, hook);
  if (!existsSync(hookPath)) {
    console.error(`❌ Missing git hook: .husky/${hook}`);
    failed = true;
    continue;
  }
  try {
    accessSync(hookPath, constants.R_OK);
    console.log(`✅ Hook exists: .husky/${hook}`);
  } catch {
    console.error(`❌ Hook not readable: .husky/${hook}`);
    failed = true;
  }
}

if (failed) {
  console.error('\n🚨 Git hooks are misconfigured. Run: pnpm prepare');
  exit(1);
} else {
  console.log('\n✅ All git hooks verified.');
}
