// @ts-check
//
// Frame folder-structure rules — enforced by eslint-plugin-project-structure.
//
// SCOPE: only the architectural directories — src/, tests/, examples/,
// migrations/, scripts/. Root config files and operational folders
// (.claude/, .husky/, .github/, docker/) are intentionally NOT modeled here;
// they're excluded by the `files` glob in eslint.config.mjs.
//
// WHAT THIS ENFORCES:
//   • src/ follows the hexagonal layout (domain / use-cases / adapters / errors
//     / observability / testing) with kebab-case filenames and the conventional
//     suffixes (.error.ts, .<impl>.ts).
//   • Bounded contexts live in subfolders: arrecadacao, taxas, pagamentos,
//     financeiro, usuario (shared infra such as cat and money stay at layer root).
//   • tests/unit/ — shared tests at root (money, cat, observability) plus BC
//     subfolders with *.test.ts and *.<impl>.test.ts.
//   • tests/integration/ and tests/helpers/ follow their own flat conventions.
//   • examples/, migrations/, and scripts/ follow their respective conventions.
//
// WHAT THIS DOES NOT ENFORCE:
//   • Import-graph rules — those live in .dependency-cruiser.cjs.
//   • Lint or format — that's Biome.
//
// To allow a new file kind in an existing directory, add a node to its
// `children`. To allow a one-off exception, add it to `ignorePatterns` below.

import { createFolderStructure } from 'eslint-plugin-project-structure';

const KEBAB = '{kebab-case}';

/** Subpastas por bounded context (linguagem ubíqua do ENGINE-DDD). */
const BC_FOLDERS = ['arrecadacao', 'taxas', 'pagamentos', 'financeiro', 'usuario', 'plataforma'];

/**
 * Application/orchestration folders — NOT BCs. They live only under
 * `use-cases/`, `errors/`, and `tests/unit/` (no `domain/`, no `adapters/`).
 * Reserved for layers that compose BCs by their ports.
 */
const APPLICATION_FOLDERS = ['checkout'];

/** @param {{ withAdapterImpl?: boolean }} [opts] */
function bcChildren(opts = {}) {
  const fileChildren = [{ name: `${KEBAB}.ts` }];
  if (opts.withAdapterImpl) {
    fileChildren.push({ name: `${KEBAB}.${KEBAB}.ts` });
  }
  return BC_FOLDERS.map((name) => ({
    name,
    children: fileChildren,
  }));
}

/** Application/orchestration folders — flat kebab-case files only. */
function applicationChildren() {
  return APPLICATION_FOLDERS.map((name) => ({
    name,
    children: [{ name: `${KEBAB}.ts` }],
  }));
}

/**
 * Domain BCs additionally allow `entities/` and `value-objects/` subfolders
 * (DDD-textbook split — the layout itself documents what has identity and
 * what doesn't). Files at the BC root are still allowed for backward
 * compatibility during the migration.
 */
function bcDomainChildren() {
  const subfolderChildren = [{ name: `${KEBAB}.ts` }];
  return BC_FOLDERS.map((name) => ({
    name,
    children: [
      { name: `${KEBAB}.ts` },
      { name: 'entities', children: subfolderChildren },
      { name: 'value-objects', children: subfolderChildren },
    ],
  }));
}

/** @param {{ withAdapterImpl?: boolean }} [opts] */
function bcTestChildren(opts = {}) {
  const fileChildren = [{ name: `${KEBAB}.test.ts` }];
  if (opts.withAdapterImpl) {
    fileChildren.push({ name: `${KEBAB}.${KEBAB}.test.ts` });
  }
  return BC_FOLDERS.map((name) => ({
    name,
    children: fileChildren,
  }));
}

/** Test folders for application/orchestration layers (e.g. checkout). */
function applicationTestChildren() {
  return APPLICATION_FOLDERS.map((name) => ({
    name,
    children: [{ name: `${KEBAB}.test.ts` }],
  }));
}

export const folderStructureConfig = createFolderStructure({
  structure: [
    // ── src/ — the architecture proper ──
    {
      name: 'src',
      children: [
        { name: 'index.ts' },
        {
          name: 'domain',
          children: [{ name: 'money.ts' }, { name: 'cat.ts' }, ...bcDomainChildren()],
        },
        {
          name: 'use-cases',
          children: [{ name: 'create-cat.ts' }, ...bcChildren(), ...applicationChildren()],
        },
        {
          name: 'adapters',
          children: [
            { name: 'database.ts' },
            { name: 'db-types.generated.ts' },
            { name: 'cat-repository.ts' },
            { name: 'cat-repository.memory.ts' },
            { name: 'cat-repository.postgres.ts' },
            { name: 'postgres.ts' },
            ...bcChildren({ withAdapterImpl: true }),
          ],
        },
        {
          name: 'errors',
          children: [
            { name: 'index.ts' },
            { name: 'cat-already-exists.error.ts' },
            { name: 'invalid-cat-name.error.ts' },
            ...BC_FOLDERS.map((name) => ({
              name,
              children: [{ name: `${KEBAB}.error.ts` }],
            })),
            ...APPLICATION_FOLDERS.map((name) => ({
              name,
              children: [{ name: `${KEBAB}.error.ts` }],
            })),
          ],
        },
        {
          name: 'observability',
          children: [{ name: `${KEBAB}.ts` }],
        },
        {
          name: 'testing',
          children: [{ name: `${KEBAB}.ts` }],
        },
      ],
    },

    // ── tests/ — same shape as src/, plus shared helpers ──
    {
      name: 'tests',
      children: [
        {
          name: 'unit',
          children: [
            { name: 'money.test.ts' },
            { name: 'cat-domain.test.ts' },
            { name: 'cat-property.test.ts' },
            { name: 'cat-repository.memory.test.ts' },
            { name: 'logger.test.ts' },
            { name: 'otel-logger.test.ts' },
            { name: 'hash-client-pii.test.ts' },
            ...bcTestChildren({ withAdapterImpl: true }),
            ...applicationTestChildren(),
          ],
        },
        {
          name: 'integration',
          children: [{ name: `${KEBAB}.test.ts` }, { name: `${KEBAB}.${KEBAB}.test.ts` }],
        },
        {
          name: 'helpers',
          children: [{ name: `${KEBAB}.ts` }, { name: `${KEBAB}.${KEBAB}.ts` }],
        },
      ],
    },

    // ── examples/ — one file per demo. ──
    {
      name: 'examples',
      children: [
        { name: `${KEBAB}.ts` },
        { name: `${KEBAB}.with-${KEBAB}.ts` },
        { name: `${KEBAB}.${KEBAB}.ts` },
      ],
    },

    // ── migrations/ — Kysely-style timestamped migrations ──
    {
      name: 'migrations',
      children: [{ name: '{snake_case}.ts' }],
    },

    // ── scripts/ — ad-hoc CLI helpers ──
    {
      name: 'scripts',
      children: [{ name: `${KEBAB}.ts` }, { name: `${KEBAB}.js` }],
    },
  ],
  ignorePatterns: ['**/*.generated.ts', '**/*.d.ts'],
});
