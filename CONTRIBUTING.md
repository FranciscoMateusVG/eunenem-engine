# Contributing to Frame

## Commit & Push Workflow

CI (`.github/workflows/ci.yml`) is the canonical quality gate: it runs on every PR to `staging` and `main`. Locally, Husky runs a fast pre-commit hook. There is no pre-push hook — it was removed on purpose (b4bde53, 2026-08-01) because it duplicated CI and hung whenever the local Docker daemon was down.

### Pre-commit hook (fast)

Runs `lint-staged` on staged files:
- Biome check + auto-fix on `*.{ts,tsx,js,json}` files

This is fast and non-disruptive. It catches formatting and simple lint issues before they're committed.

### `pnpm check` (full verification, run before you push)

The complete local Definition of Done:

```bash
pnpm lint              # Biome lint
pnpm depcruise         # Architectural rules
pnpm typecheck         # TypeScript strict
pnpm check:codegen-drift  # Generated types match schema
pnpm test:coverage     # All tests + coverage thresholds
tsx examples/*.ts      # Examples run cleanly
pnpm verify-hooks      # Hooks are installed
```

If **any** of these fail, the work is not done. Fix the code, don't bypass the gate.

## ⚠️ --no-verify is Forbidden

**Do not use `git push --no-verify` or `git commit --no-verify`.**

Bypassing the pre-commit hook means unformatted or unlinted code reaches the branch, and CI will reject it anyway.

This is not a suggestion — it's a rule. For human contributors and AI agents alike.

If you believe a hook is producing a false positive:
1. Investigate the failure
2. Fix the root cause (in the code or in the hook configuration)
3. Push normally

If you're stuck and need to push a WIP branch for backup or collaboration, create a draft PR and note in the description that checks are not passing.

## How the Hooks Work

- **Husky** manages git hooks in `.husky/`
- **lint-staged** (configured in `lint-staged.config.js`) runs Biome on staged files during pre-commit; `*.generated.ts` is skipped (ignored by Biome)
- `pnpm verify-hooks` (part of `pnpm check`) confirms the pre-commit hook is installed and readable

Hooks are installed automatically via the `prepare` script when you run `pnpm install`.

## Working with Migrations

1. Create a new migration file in `migrations/` following the naming convention: `YYYYMMDD_NNN_description.ts`
2. Start your dev database: `pnpm db:up`
3. Run the migration: `pnpm db:migrate`
4. Regenerate types: `pnpm db:codegen`
5. Commit the updated `src/adapters/db-types.generated.ts`

The codegen drift check in `pnpm check` will catch if you forget step 4-5.

## Test Organization

```
tests/
├── unit/           # Fast tests using in-memory adapters
│   ├── money.test.ts, cat-*.test.ts, …   # shared / skeleton at root
│   ├── arrecadacao/   # BC subfolders (short PT names)
│   ├── taxas/
│   ├── pagamentos/
│   ├── financeiro/
│   └── usuario/
├── integration/    # Tests against real Postgres via Testcontainers
└── helpers/        # Shared test utilities (e.g., Testcontainers setup)
```

- **Unit tests**: Use the in-memory adapter. Fast, no Docker needed. Place BC tests under `tests/unit/<bc>/` (e.g. `tests/unit/pagamentos/repository.memory.test.ts`); keep `money`, Cat, and observability tests at `tests/unit/` root.
- **Integration tests**: Spin up Postgres via Testcontainers. Docker must be running.
- **Property-based tests**: Use fast-check in `tests/unit/`. Good for invariants.
- **Examples**: `examples/*.ts` run as smoke tests during `pnpm check`.

## Architectural Rules

Enforced by dependency-cruiser (see `.dependency-cruiser.cjs`):

1. `domain/` → can only import from `domain/`
2. `use-cases/` → can import from `domain/` and adapter interfaces, not concrete implementations
3. Nothing imports from `index.ts` internally
4. No circular dependencies

Run `pnpm depcruise` to check manually.
