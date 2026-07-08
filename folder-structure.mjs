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
//   • Bounded contexts (ENGINE-DDD ubiquitous language) live in subfolders:
//     arrecadacao, taxas, pagamentos, evento, usuario, plataforma. Shared infra
//     (cat, money) stays at layer root. `financeiro` is NOT a top-level BC — it
//     is a §2.5 nested MÓDULO under pagamentos (see financeiro* nodes below).
//     email / storage / webhook-archive are supporting INFRA adapters
//     (adapters-only, no domain/use-cases/errors of their own).
//   • tests/unit/ — a tiny explicit root allowlist (no wildcard) plus one
//     subfolder per import-target: <bc>/, <infra>/, server/, observability/.
//     A test file lives in the folder of its PRIMARY import target (Izzy's
//     policy, aperture-o6y48). Anything new at tests/unit root is a lint error
//     by design — it forces the author to pick the right home.
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

/**
 * Bounded contexts (ENGINE-DDD ubiquitous language). `financeiro` is
 * DELIBERATELY absent — it is a §2.5 nested MÓDULO under Pagamentos (it fails
 * lifecycle-independence, so it is not a top-level BC). It appears inside
 * pagamentos/ in every src layer via the financeiro* nodes below.
 */
const BC_FOLDERS = ['arrecadacao', 'taxas', 'pagamentos', 'evento', 'usuario', 'plataforma'];

/**
 * Supporting INFRA adapters (ENGINE-DDD) — they have adapters ONLY, no
 * domain/, use-cases/, or errors/ of their own. They compose no ubiquitous
 * language; they are ports to the outside world (SMTP, object storage, the
 * raw-webhook archive).
 */
const INFRA_ADAPTER_FOLDERS = ['email', 'storage', 'webhook-archive'];

/**
 * Application/orchestration folders — NOT BCs. They live only under
 * `use-cases/`, `errors/`, and `tests/unit/` (no `domain/`, no `adapters/`).
 * Reserved for layers that compose BCs by their ports.
 */
const APPLICATION_FOLDERS = ['checkout'];

// ── financeiro nested-module nodes (spliced into `pagamentos/` per layer) ──
// financeiro (§2.5) lives under pagamentos in every src layer. Its shape per
// layer mirrors a BC's own layer shape.
const financeiroDomainNode = {
  name: 'financeiro',
  children: [
    { name: `${KEBAB}.ts` },
    { name: 'entities', children: [{ name: `${KEBAB}.ts` }] },
    { name: 'value-objects', children: [{ name: `${KEBAB}.ts` }] },
  ],
};
const financeiroUseCaseNode = { name: 'financeiro', children: [{ name: `${KEBAB}.ts` }] };
const financeiroErrorNode = { name: 'financeiro', children: [{ name: `${KEBAB}.error.ts` }] };
const financeiroAdapterNode = {
  name: 'financeiro',
  children: [{ name: `${KEBAB}.ts` }, { name: `${KEBAB}.${KEBAB}.ts` }],
};

/**
 * BC folders for `use-cases/` (flat files) and `adapters/` (files + impl
 * variants when `withAdapterImpl`). Pagamentos additionally carries the nested
 * financeiro module.
 * @param {{ withAdapterImpl?: boolean }} [opts]
 */
function bcChildren(opts = {}) {
  const fileChildren = [{ name: `${KEBAB}.ts` }];
  if (opts.withAdapterImpl) {
    fileChildren.push({ name: `${KEBAB}.${KEBAB}.ts` });
  }
  return BC_FOLDERS.map((name) => {
    const children = [...fileChildren];
    if (name === 'pagamentos') {
      children.push(opts.withAdapterImpl ? financeiroAdapterNode : financeiroUseCaseNode);
    }
    return { name, children };
  });
}

/** Supporting-infra adapter folders — flat files + impl variants. */
function infraAdapterChildren() {
  return INFRA_ADAPTER_FOLDERS.map((name) => ({
    name,
    children: [{ name: `${KEBAB}.ts` }, { name: `${KEBAB}.${KEBAB}.ts` }],
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
 * compatibility during the migration. Pagamentos also carries nested
 * financeiro (§2.5).
 */
function bcDomainChildren() {
  const subfolderChildren = [{ name: `${KEBAB}.ts` }];
  return BC_FOLDERS.map((name) => {
    const children = [
      { name: `${KEBAB}.ts` },
      { name: 'entities', children: subfolderChildren },
      { name: 'value-objects', children: subfolderChildren },
    ];
    if (name === 'pagamentos') {
      children.push(financeiroDomainNode);
    }
    return { name, children };
  });
}

/** BC error folders — `<kebab>.error.ts`; pagamentos carries nested financeiro. */
function bcErrorChildren() {
  return BC_FOLDERS.map((name) => {
    const children = [{ name: `${KEBAB}.error.ts` }];
    if (name === 'pagamentos') {
      children.push(financeiroErrorNode);
    }
    return { name, children };
  });
}

/**
 * tests/unit test-folder file patterns. A test may carry impl qualifiers
 * (`.memory`, `.postgres`, `.better-auth.timing`, `.memory.conformance`), so
 * allow 1..3 dotted kebab segments before `.test.ts`. This is a STRUCTURED
 * pattern, not a wildcard escape-hatch.
 * @param {number} maxDots 1, 2, or 3
 */
function testFiles(maxDots) {
  const nodes = [{ name: `${KEBAB}.test.ts` }];
  if (maxDots >= 2) nodes.push({ name: `${KEBAB}.${KEBAB}.test.ts` });
  if (maxDots >= 3) nodes.push({ name: `${KEBAB}.${KEBAB}.${KEBAB}.test.ts` });
  return nodes;
}

/**
 * tests/unit BC test folder for the nested financeiro module — mirrors the
 * src tree (financeiro lives under pagamentos, ENGINE-DDD §2.5), so its tests
 * live at tests/unit/pagamentos/financeiro/ (Izzy's ruling on aperture-o6y48:
 * the test tree mirrors src; no top-level financeiro exception — an in-place
 * exception on day one is how the registry drifts again).
 */
const financeiroTestNode = { name: 'financeiro', children: testFiles(3) };

/** Test folders for BCs. Pagamentos carries the nested financeiro test folder. */
function bcTestChildren() {
  return BC_FOLDERS.map((name) => {
    const children = testFiles(3);
    if (name === 'pagamentos') {
      children.push(financeiroTestNode);
    }
    return { name, children };
  });
}

/** Test folders mirroring the supporting-infra adapters. */
function infraTestChildren() {
  return INFRA_ADAPTER_FOLDERS.map((name) => ({ name, children: testFiles(2) }));
}

/** Test folders for application/orchestration layers (e.g. checkout). */
function applicationTestChildren() {
  return APPLICATION_FOLDERS.map((name) => ({ name, children: testFiles(2) }));
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
            ...infraAdapterChildren(),
          ],
        },
        {
          name: 'errors',
          children: [
            { name: 'index.ts' },
            { name: 'cat-already-exists.error.ts' },
            { name: 'invalid-cat-name.error.ts' },
            ...bcErrorChildren(),
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
            // Root allowlist — explicit, tiny, NO wildcard. Anything new at
            // root is a lint error by design (forces the author to pick a home).
            { name: 'money.test.ts' },
            { name: 'global-setup-shouldSpin.test.ts' },
            { name: 'cat-domain.test.ts' },
            { name: 'cat-property.test.ts' },
            { name: 'cat-repository.memory.test.ts' },
            // Import-target folders.
            ...bcTestChildren(),
            ...infraTestChildren(),
            { name: 'server', children: testFiles(2) },
            { name: 'observability', children: testFiles(2) },
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
