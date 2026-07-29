/**
 * Playwright fixtures for the eunenem engine E2E suite (aperture-ilji3).
 *
 * Provides:
 *   - `seededData` — a per-test fixture that seeds a fresh usuario +
 *     campanha + recebedor + contribuição via the engine's domain
 *     factories + repositories DIRECTLY (no UI), returning the slug,
 *     campanha id, contribuição id, and session cookie token.
 *   - `authenticatedPage` — a Playwright Page with the BetterAuth
 *     session cookie pre-set, ready to navigate to /painel/&lt;slug&gt;/lista.
 *
 * No cleanup in Phase 1 — each run uses unique email + slug suffix to
 * avoid collisions. CI follow-up bead adds testcontainers + isolated
 * DB; until then operator's dev DB accumulates `e2e-test-*` rows that
 * can be wiped periodically.
 *
 * Authentication uses the real BetterAuth magic-link plugin with a captured
 * delivery URL. The running server then resolves that signed cookie through
 * auth.me and self-heals the domain Usuario + default campanha exactly as the
 * production OAuth/magic-link path does. The fixture only adds domain data
 * needed by its tests after that passwordless provisioning completes.
 */

import { randomUUID } from 'node:crypto';
import { type BrowserContext, test as base, type Page } from '@playwright/test';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarContribuicao } from '../src/domain/arrecadacao/entities/contribuicao.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import type { IdCampanha } from '../src/domain/arrecadacao/value-objects/ids.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import {
  browserCookieFor,
  type MagicLinkSession,
  mintMagicLinkSession,
} from './magic-link-auth.js';

// Admin allowlist session (aperture-0k84n, cluster C).
//
// AdminShell (aperture-r5fg0) gained a UX auth gate: it reads
// `auth.me.isAdmin` and, for a non-admin (incl. logged-out) visitor,
// `window.location.assign('/')` bounces to the marketing landing page. The
// backend `adminProcedure` (aperture-4n222 / #313) is the real boundary —
// every `admin.*` proc 403s a non-allowlisted user server-side. Both read the
// SAME allowlist parsed at boot from `ADMIN_ALLOWED_EMAILS`.
//
// So an admin e2e spec must arrive with a session whose email is in that
// allowlist. This email is pinned into the Playwright webServer env
// (`ADMIN_ALLOWED_EMAILS`, playwright.config.ts) so the boot-time set and the
// fixture agree. The admin is a SEPARATE user from `seededData`'s campaign
// owner — admins view ANY campaign; the owner just supplies the data under test.
//
// FIXED (not per-run) email: the allowlist is parsed once at server boot, so
// it can't learn a random per-run address. The fixture is therefore
// find-or-create idempotent — the admin account is created once and reused,
// which also sidesteps the slug-walk exhaustion that a fresh signup every run
// would cause (see the `seededData` suffix note below).
const ADMIN_EMAIL = 'e2e-admin@e2e.local';
const ADMIN_NOME = 'E2e Admin';

// Defaults to the engine's docker-compose Postgres on port 54320 (per
// .env.example). Override via E2E_DATABASE_URL or DATABASE_URL.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

export interface SeededData {
  /** Engine-derived slug (e.g. `e2e-test-helena-{suffix}`). The URL is /painel/{slug}/lista. */
  slug: string;
  /** Display name used during signup — appears in painel headers. */
  nomeExibicao: string;
  /** Email used during signup — unique per test run. */
  email: string;
  /** Campanha id created by magic-link auth.me self-heal. */
  idCampanha: IdCampanha;
  /** The default 'presente' opção id (where contribuições live). */
  idOpcaoPresentes: string;
  /** The single seeded contribuição's id — the gift the test will edit. */
  idContribuicao: string;
  /** Original gift name — useful for selector + assertion baselines. */
  nomeContribuicao: string;
  /** Original gift cents value. */
  valorContribuicao: number;
  /** Signed BetterAuth session minted through the real magic-link flow. */
  session: MagicLinkSession;
}

interface SeedFixtures {
  /** Per-test seeded data. Each test gets its own user/campanha/contribuição. */
  seededData: SeededData;
  /** A browser context with the BetterAuth session cookie pre-set. */
  authenticatedContext: BrowserContext;
  /** A Page from the authenticated context, ready to navigate. */
  authenticatedPage: Page;
  /**
   * A browser context carrying an ALLOWLISTED ADMIN session cookie — clears
   * the AdminShell UX gate (aperture-r5fg0) so `/admin/*` renders the real
   * chrome instead of bouncing to the landing page. Idempotent find-or-create
   * on a fixed allowlisted email (see ADMIN_EMAIL).
   */
  adminAuthenticatedContext: BrowserContext;
  /** A Page from the admin context, ready to navigate to `/admin/*`. */
  adminAuthenticatedPage: Page;
}

/**
 * Engine deps shaped for the post-auth seed flow. Full ServerDeps would drag
 * in Stripe and OTel that the seed does not touch.
 */
function buildSeedDeps(db: Database) {
  const logger = new NoopLogger();
  const observability = { logger, tracer: noopTracer() };
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    clock: () => new Date(),
    observability,
  };
}

export const test = base.extend<SeedFixtures>({
  /**
   * Per-test seed: provisions a fresh usuario, attaches a recebedor,
   * inserts a single contribuição, returns identifiers + a fresh
   * BetterAuth session token. No cleanup yet (Phase 1).
   */
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture with no dependencies — the empty destructure is the documented idiom.
  seededData: async ({}, use) => {
    const db = createDatabase(DATABASE_URL);
    const deps = buildSeedDeps(db);

    const runSuffix = randomUUID().slice(0, 8);
    // The unique suffix MUST live in the FIRST name token: the slug base is
    // derived from it, and a shared base ("e2e") exhausts the 50-attempt
    // collision walk once enough e2e rows accumulate in the dev DB
    // (resolveSlugInPlataforma, registrar-conta-usuario.ts — root-caused
    // 2026-07-07, aperture-8jcec).
    const nomeExibicao = `E2e${runSuffix} Helena`;
    const email = `e2e-test-${runSuffix}@e2e.local`;

    console.log(`[seededData] starting magic-link signup for ${email}…`);
    // Step 1 — BetterAuth creates the auth principal; auth.me self-heals the
    // domain Usuario + default campanha through the production path.
    const session = await mintMagicLinkSession(db, {
      email,
      name: nomeExibicao,
      baseURL: BASE_URL,
    });
    const usuario = await deps.usuarioRepository.findUsuarioByEmail(
      ID_PLATAFORMA_EUNENEM as never,
      email,
    );
    if (!usuario) throw new Error(`seededData: auth.me did not provision ${email}`);
    const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(usuario.idConta);
    const campanha = campanhas.find((candidate) => candidate.titulo === `Lista de ${nomeExibicao}`);
    if (!campanha) {
      throw new Error(
        `seededData: no default campanha for ${email}; got ${JSON.stringify(
          campanhas.map((candidate) => candidate.titulo),
        )}`,
      );
    }
    console.log(
      `[seededData] magic-link signup OK, slug=${usuario.slug}, idCampanha=${campanha.id}`,
    );

    const opcaoPresentes = campanha.opcoes.find((o) => o.tipo === 'presente');
    if (!opcaoPresentes) {
      await db.destroy();
      throw new Error('seededData: saga did not create the "presente" opção.');
    }

    // Step 2 — attach a recebedor so the campanha is "complete" (otherwise
    // findByAdministrador returns undefined and the painel renders empty).
    const recebedor = criarRecebedorInicial({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      dadosRecebedor: {
        // aperture-8ro9v — DadosRecebedor is a discriminated union by
        // `metodo` (aperture-mcvyw). Without `metodo: 'pix'` the column
        // mapping (recebedor-repository.postgres.ts:47) falls to the
        // 'conta' branch with null bank fields and violates the
        // recebedores_variante_check constraint at save time.
        metodo: 'pix',
        nomeTitular: nomeExibicao,
        // Migration 20260709_036 tightened recebedores_variante_check to
        // require cpf_titular NOT NULL. Checksum-valid canonical fake so
        // the seed satisfies both the DB constraint and the domain refine.
        cpfTitular: '11144477735',
        tipoChavePix: 'email',
        chavePix: email,
      },
      criadaEm: deps.clock(),
    });
    await deps.recebedorRepository.save(recebedor);

    // Step 3 — seed ONE contribuição (the gift the saveEdit test will edit).
    const nomeContribuicao = `Fralda Premium ${runSuffix}`;
    const valorContribuicao = 8000;
    const contribuicao = criarContribuicao({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      idOpcaoContribuicao: opcaoPresentes.id,
      nome: nomeContribuicao,
      valor: valorContribuicao as never,
      criadaEm: deps.clock(),
    });
    await deps.contribuicaoRepository.save(contribuicao);

    await use({
      slug: usuario.slug,
      nomeExibicao,
      email,
      idCampanha: campanha.id,
      idOpcaoPresentes: opcaoPresentes.id,
      idContribuicao: contribuicao.id as unknown as string,
      nomeContribuicao,
      valorContribuicao,
      session,
    });

    await db.destroy();
  },

  /** Browser context with the BetterAuth session cookie pre-set. */
  authenticatedContext: async ({ browser, seededData, baseURL }, use) => {
    const resolvedBaseURL = baseURL ?? BASE_URL;
    const context = await browser.newContext();
    await context.addCookies([browserCookieFor(seededData.session, resolvedBaseURL)]);
    await use(context);
    await context.close();
  },

  /** Ready-to-navigate authenticated Page. */
  authenticatedPage: async ({ authenticatedContext }, use) => {
    const page = await authenticatedContext.newPage();
    await use(page);
    await page.close();
  },

  /**
   * Browser context with an ALLOWLISTED ADMIN session cookie pre-set.
   *
   * Find-or-create idempotent on the fixed ADMIN_EMAIL through the shared
   * magic-link helper. The email is pinned into the webServer's
   * `ADMIN_ALLOWED_EMAILS` env so `auth.me.isAdmin` resolves true and the
   * AdminShell gate (aperture-r5fg0) lets the real admin chrome render.
   */
  adminAuthenticatedContext: async ({ browser, baseURL }, use) => {
    const db = createDatabase(DATABASE_URL);
    const resolvedBaseURL = baseURL ?? BASE_URL;
    const session = await mintMagicLinkSession(db, {
      email: ADMIN_EMAIL,
      name: ADMIN_NOME,
      baseURL: resolvedBaseURL,
    });
    await db.destroy();

    const context = await browser.newContext();
    await context.addCookies([browserCookieFor(session, resolvedBaseURL)]);
    await use(context);
    await context.close();
  },

  /** Ready-to-navigate admin Page (allowlisted session). */
  adminAuthenticatedPage: async ({ adminAuthenticatedContext }, use) => {
    const page = await adminAuthenticatedContext.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
