/**
 * aperture-8jcec — /campanhas multicampanha migration bridge E2E (epic aperture-7hm2g).
 *
 * User-path spec (design spec §9) against Vance's CampanhasPage (PR #321) +
 * Rex's campanhas.list (PR #320):
 *   - legacy-matching user sees the mixed grid: 1.0 card + 2.0 card + NOVA LISTA
 *   - 1.0 card is a REAL anchor to https://eunenem.com/minha-area (we assert the
 *     attribute — no cross-navigation into prod Clerk from CI; the Clerk leg is
 *     covered by the operator-assisted staging walk, per verify-user-path)
 *   - 2.0 card CTA navigates to the user's /painel/:slug (clicked, not just seen)
 *   - welcome modal: first-visit shows (legado > 0 + flag absent), OK dismisses +
 *     persists CAMPANHAS_WELCOME_STORAGE_KEY, return-visit stays hidden
 *   - pure-2.0 user: no 1.0 card, no welcome modal
 *   - anonymous: route resolves 200 (status asserted FIRST — playwright-gotchas §3)
 *     then client-side bounce to /
 *   - NOVA LISTA: POC stub — click fires a toast (NO creation flow exists yet;
 *     spec §11 deviation flagged to GLaDOS 2026-07-07, campanhas.criar is a filed
 *     follow-up. When the real flow ships, THIS test must be rewritten to walk it.)
 *
 * LEGACY SEED: the repo-shipped legacy-1.0-users.json contains exactly the
 * operator email, so the legacy-path tests authenticate as a local user
 * registered with that email. The seed is IDEMPOTENT (register-or-login):
 * first run registers (unique-email constraint), later runs just mint a session.
 */
import { randomUUID } from 'node:crypto';
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import {
  CAMPANHAS_WELCOME_STORAGE_KEY,
  LEGACY_DASHBOARD_URL,
} from '../apps/eunenem-server/pages/lib/campanhas.js';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { criarSessaoUsuario } from '../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';
import { test as seededTest } from './fixtures.js';

const SESSION_COOKIE = 'better-auth.session_token';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** MUST match the repo-shipped legacy-1.0-users.json entry (case differs on purpose —
 *  the whole point is the case-insensitive match, spec §4). */
const LEGACY_EMAIL = 'FranciscoMateusVG@gmail.com';
const LEGACY_PASSWORD = 'senha-e2e-legacy-walker-123';

function buildSeedDeps(db: Database) {
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    authService: new AuthServiceBetterAuth(db, { clock: () => new Date() }),
    clock: () => new Date(),
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

/**
 * Register-or-REPAIR-then-login as the legacy-matching user. Idempotent AND
 * self-healing across dev-DB states:
 *   - fresh DB → registrarContaUsuario creates user + campanha (+ recebedor).
 *   - user already exists (e.g. the OPERATOR's own OAuth dev login, which
 *     leaves NO credential `accounts` row — root-caused 2026-07-07) → repair:
 *     upsert the credential row with OUR password hash (mirrors criarConta's
 *     write shape: provider_id='credential', account_id=`{plataforma}::{email}`)
 *     and seed a campanha via the criarCampanha use-case if the conta owns none
 *     (so the 2.0-card assertions hold).
 * LOCAL dev DB only — this never touches staging/prod.
 */
async function mintLegacySession(): Promise<string> {
  const db = createDatabase(DATABASE_URL);
  const deps = buildSeedDeps(db);
  try {
    try {
      const { campanha } = await registrarContaUsuario(deps, {
        idUsuario: randomUUID() as never,
        idConta: randomUUID() as never,
        idPlataforma: ID_PLATAFORMA_EUNENEM as never,
        email: LEGACY_EMAIL,
        nomeExibicao: 'Legacy Walker E2E',
        senhaSimulada: LEGACY_PASSWORD,
      });
      // Attach a recebedor so the auto-created campanha is "complete" and
      // surfaces as a 2.0 card (mirrors e2e/fixtures.ts step 2).
      await deps.recebedorRepository.save(
        criarRecebedorInicial({
          id: randomUUID() as never,
          idCampanha: campanha.id,
          dadosRecebedor: {
            metodo: 'pix',
            nomeTitular: 'Legacy Walker E2E',
            tipoChavePix: 'email',
            chavePix: LEGACY_EMAIL,
          },
          criadaEm: deps.clock(),
        }),
      );
    } catch {
      await repairExistingLegacyUser(db, deps);
    }
    const sessao = await criarSessaoUsuario(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email: LEGACY_EMAIL,
      senhaSimulada: LEGACY_PASSWORD,
    });
    return sessao.token;
  } finally {
    await db.destroy();
  }
}

/** See mintLegacySession — the user-exists repair path. */
async function repairExistingLegacyUser(
  db: Database,
  deps: ReturnType<typeof buildSeedDeps>,
): Promise<void> {
  const emailLower = LEGACY_EMAIL.toLowerCase();

  const usuario = await db
    .selectFrom('usuarios')
    .select(['id', 'id_conta'])
    .where('email', '=', emailLower)
    .executeTakeFirst();
  if (!usuario) {
    throw new Error(
      `legacy seed: registrarContaUsuario failed but no usuarios row for ${emailLower} — ` +
        'the register error was NOT email-exists; rerun with the seed debug script.',
    );
  }

  // 1. Credential account upsert (BetterAuth `accounts`, provider 'credential').
  const passwordHash = await hashPassword(LEGACY_PASSWORD);
  const accountId = `${ID_PLATAFORMA_EUNENEM}::${emailLower}`;
  const existing = await db
    .selectFrom('accounts')
    .select('id')
    .where('provider_id', '=', 'credential')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  const now = new Date();
  if (existing) {
    await db
      .updateTable('accounts')
      .set({ password: passwordHash, updated_at: now })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('accounts')
      .values({
        id: randomUUID(),
        user_id: usuario.id,
        provider_id: 'credential',
        account_id: accountId,
        password: passwordHash,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  // 2. Campanha: the OAuth-created dev user owns none → 2.0-card assertions
  //    would fail on an empty grid. Seed one through the domain use-case.
  const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(
    usuario.id_conta as never,
  );
  if (campanhas.length === 0) {
    await criarCampanha(deps, {
      id: randomUUID() as never,
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      idsAdministradores: [usuario.id_conta] as never,
      titulo: 'Lista do Legacy Walker (2.0)',
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Legacy Walker E2E',
        tipoChavePix: 'email',
        chavePix: emailLower,
      },
    });
  }
}

interface LegacyFixtures {
  /** Context authenticated as the legacy-JSON-matching user. Fresh per test
   *  (fresh context = empty localStorage = deterministic first-visit state). */
  legacyContext: BrowserContext;
  legacyPage: Page;
}

const test = base.extend<LegacyFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture with no dependencies — the empty destructure is the documented idiom.
  legacyContext: async ({ browser, baseURL }, use) => {
    const token = await mintLegacySession();
    const url = new URL(baseURL ?? BASE_URL);
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: encodeURIComponent(token),
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await use(context);
    await context.close();
  },
  legacyPage: async ({ legacyContext }, use) => {
    const page = await legacyContext.newPage();
    await use(page);
    await page.close();
  },
});

test.describe('/campanhas — legacy-matching user (the POC user path, spec §9)', () => {
  test('mixed grid renders: 1.0 card + 2.0 card + NOVA LISTA, with correct CTA targets', async ({
    legacyPage,
  }) => {
    const res = await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    expect(res, 'goto must return a Response').toBeTruthy();
    expect(res?.status(), '/campanhas must resolve 200 for an authed user').toBe(200);

    const grid = legacyPage.getByTestId('campanhas-grid');
    await expect(grid).toBeVisible();

    // 1.0 card — visible, selo carries literal text (WCAG 1.4.1: not color-only),
    // CTA is a REAL anchor to the legacy dashboard. Attribute assertion, no
    // cross-nav: the Clerk leg belongs to the operator-assisted staging walk.
    const cardLegado = legacyPage.getByTestId('card-legado').first();
    await expect(cardLegado).toBeVisible();
    await expect(cardLegado).toContainText('1.0');
    const legadoCta = cardLegado.locator(`a[href="${LEGACY_DASHBOARD_URL}"]`);
    await expect(legadoCta).toBeVisible();

    // 2.0 card — visible, selo text, CTA points at a /painel/:slug URL.
    const cardNova = legacyPage.getByTestId('card-campanha').first();
    await expect(cardNova).toBeVisible();
    await expect(cardNova).toContainText('2.0');
    await expect(cardNova.locator('a.camp-cta')).toHaveAttribute(
      'href',
      /^\/painel\/[a-z][a-z0-9-]{2,29}$/,
    );

    // NOVA LISTA card present.
    await expect(legacyPage.getByTestId('card-nova-lista')).toBeVisible();
  });

  test('2.0 card CTA actually navigates to the painel (click, not just observe)', async ({
    legacyPage,
  }) => {
    // Not a modal test — pre-seed the dismissed flag so the welcome overlay
    // can never intercept the click. (A visible-check guard races hydration:
    // the modal mounts only after campanhas.list resolves — learned 2026-07-07.)
    await legacyPage.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await legacyPage.getByTestId('card-campanha').first().locator('a.camp-cta').click();
    await legacyPage.waitForURL(/\/painel\/[a-z][a-z0-9-]{2,29}$/);
    // Destination is a real page, not the not-found shell.
    await expect(legacyPage.locator('body')).not.toContainText('Página não encontrada');
  });

  test('NOVA LISTA click fires the POC stub toast (spec §11 deviation — see header)', async ({
    legacyPage,
  }) => {
    // Not a modal test — pre-seed the dismissed flag (see click-test comment).
    await legacyPage.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await legacyPage.getByTestId('card-nova-lista').click();
    // sonner toast — the current POC behavior. NOT the spec §11 acceptance
    // ("starts a 2.0 campaign creation"); deviation flagged on aperture-8jcec
    // + the epic. Rewrite this test when campanhas.criar ships.
    await expect(legacyPage.locator('[data-sonner-toast]')).toBeVisible();
  });

  test('welcome modal: first visit shows; OK dismisses + persists flag; reload stays hidden', async ({
    legacyPage,
  }) => {
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });

    // Fresh context = empty localStorage = first visit. legado > 0 → modal fires.
    const modal = legacyPage.getByTestId('welcome-modal');
    await expect(modal).toBeVisible();

    await legacyPage.getByTestId('welcome-modal-ok').click();
    await expect(modal).toBeHidden();

    const flag = await legacyPage.evaluate(
      (key) => window.localStorage.getItem(key),
      CAMPANHAS_WELCOME_STORAGE_KEY,
    );
    expect(flag, 'dismiss must persist the storage flag').toBe('1');

    await legacyPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(legacyPage.getByTestId('campanhas-grid')).toBeVisible();
    await expect(legacyPage.getByTestId('welcome-modal')).toHaveCount(0);
  });

  test('welcome modal: pre-seeded flag (return visit) never shows the modal', async ({
    legacyPage,
  }) => {
    await legacyPage.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await expect(legacyPage.getByTestId('campanhas-grid')).toBeVisible();
    await expect(legacyPage.getByTestId('welcome-modal')).toHaveCount(0);
  });
});

seededTest.describe('/campanhas — pure-2.0 user (no legacy entry)', () => {
  seededTest(
    'shows 2.0 card + NOVA LISTA but NO 1.0 card and NO welcome modal',
    async ({ authenticatedPage }) => {
      // seededData mints a random @e2e.local email — guaranteed absent from
      // legacy-1.0-users.json.
      const res = await authenticatedPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      expect(res?.status()).toBe(200);

      await expect(authenticatedPage.getByTestId('campanhas-grid')).toBeVisible();
      await expect(authenticatedPage.getByTestId('card-campanha').first()).toBeVisible();
      await expect(authenticatedPage.getByTestId('card-nova-lista')).toBeVisible();

      // No legacy surface for a pure-2.0 user (Vance behavior note 1: the
      // modal copy is about "sua conta anterior" — never shown without legado).
      await expect(authenticatedPage.getByTestId('card-legado')).toHaveCount(0);
      await expect(authenticatedPage.getByTestId('welcome-modal')).toHaveCount(0);
    },
  );
});

base.describe('/campanhas — anonymous visitor', () => {
  base('route resolves 200 (status FIRST) then client-side bounce to /', async ({ page }) => {
    // playwright-gotchas §3: assert the HTTP status BEFORE content — the route
    // resolves 200 unconditionally (content, not status, reflects auth; same
    // pattern as /painel), then CampanhasPage bounces anonymous → "/".
    const res = await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    expect(res, 'goto must return a Response').toBeTruthy();
    expect(res?.status(), 'route itself must resolve, not 404').toBe(200);

    await page.waitForURL(/\/$/, { timeout: 10_000 });
    await expect(page.getByTestId('campanhas-grid')).toHaveCount(0);
  });
});
