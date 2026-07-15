/**
 * aperture-8bac7 (routing half) — post-login needsOnboarding gate
 * (PR #328 / aperture-ivu2t).
 *
 * WHAT IS UNDER TEST: after login, an account that still needs onboarding is
 * routed to /painel/<slug> where PainelPage mounts the BLOCKING
 * OnboardingWizard; an onboarded account is routed to /campanhas. Two gate
 * sites share the SAME `needsOnboarding(me)` expression
 * (pages/lib/onboarding-gate.ts):
 *   1. useOauthReturnRedirect.ts — the OAuth-return leg ('/?oauth=1' marker
 *      set as BetterAuth callbackURL by AuthModalShell), and
 *   2. PainelPage.tsx — the destination-side gate that mounts the wizard.
 *
 * DESIGN DECISIONS (fixed by the QA lead — do not re-litigate here):
 *
 *  - NO auth.me MOCKING. `needsOnboarding` is DERIVED server-side from
 *    perfil.nomeBebe (auth-router.ts `me` procedure): registrarContaUsuario
 *    creates NO PerfilCriador row, so a fresh seeded user is GENUINELY
 *    needsOnboarding=true. For the =false case we seed a perfil with
 *    nomeBebe set via a direct PerfilCriadorRepositoryPostgres write
 *    (criarPerfilCriador + save — same direct-engine-write style as
 *    e2e/fixtures.ts). Real derivation beats mock drift: a route.fulfill
 *    mock of auth.me would keep passing after the server-side derivation
 *    changed shape, which is exactly the regression this suite must catch.
 *
 *  - OAUTH-RETURN SIMULATION: a valid BetterAuth session cookie + goto
 *    '/?oauth=1' is byte-for-byte what the real Google callback leaves
 *    behind (cookie set by the callback, full-page land on the landing with
 *    the marker). useOauthReturnRedirect then runs the REAL gate — fetches
 *    real auth.me, strips the marker via history.replaceState BEFORE
 *    redirecting, and window.location.assign()s the target.
 *
 *  - DOCUMENTED GAP — the EMAIL-LOGIN leg is not UI-drivable: the auth modal
 *    is magic-link-only (no password field), so its post-login branch cannot
 *    be reached end-to-end from the UI in this suite. That leg's decision
 *    code is the IDENTICAL `needsOnboarding(me) ? /painel/<slug> :
 *    /campanhas` expression (AuthModalProvider.tsx onAuthenticated,
 *    ~130-166), pinned by the unit matrix in
 *    tests/unit/8bac7-onboarding-gate.test.ts plus these OAuth-path tests —
 *    same expression, same gate module, exercised here through the OAuth
 *    surface and there through the unit matrix.
 *
 * SELECTORS:
 *  - Wizard: role=dialog, aria-label "Vamos montar sua página"
 *    (OnboardingWizard.tsx auth-backdrop).
 *  - Dashboard chrome: `.painel-menu-grid` (PainelMenu.tsx) — rendered only
 *    inside the real dashboard branch of PainelPage; when the wizard blocks,
 *    PainelPage returns the wizard INSTEAD of PainelLayout, so the menu grid
 *    must have count 0.
 *  - Campanhas: data-testid="campanhas-grid" (CampanhasPage.tsx — present in
 *    both the skeleton and loaded states, so visibility is hydration-safe).
 *
 * BANKED GOTCHA: the /campanhas welcome modal intercepts pointer events for
 * legacy-matching users — we pre-seed CAMPANHAS_WELCOME_STORAGE_KEY='1' via
 * addInitScript on every context so it can never race these assertions.
 */

import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { PerfilCriadorRepositoryPostgres } from '../src/adapters/usuario/perfil-criador-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { criarPerfilCriador } from '../src/domain/usuario/entities/perfil-criador.js';
import { conteudoPerfilCriadorVazio } from '../src/domain/usuario/value-objects/conteudo-perfil-criador.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { criarSessaoUsuario } from '../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** Wizard dialog — OnboardingWizard.tsx renders role=dialog with this label. */
const WIZARD_LABEL = 'Vamos montar sua página';

interface SeededUser {
  slug: string;
  sessionToken: string;
}

/** Engine deps for the seed flow — mirrors e2e/fixtures.ts buildSeedDeps. */
function buildSeedDeps(db: Database) {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    perfilCriadorRepository: new PerfilCriadorRepositoryPostgres(db),
    authService: new AuthServiceBetterAuth(db, { clock: () => new Date() }),
    clock: () => new Date(),
    observability,
  };
}

/**
 * Seed a fresh user + session directly through the engine (no UI).
 *
 * registrarContaUsuario creates usuario + conta + default campanha but NO
 * PerfilCriador row → the account is GENUINELY needsOnboarding=true (the
 * auth.me derivation reads perfil.nomeBebe). With `onboarded: true` we
 * additionally write a perfil whose nomeBebe is set — a direct
 * criarPerfilCriador + PerfilCriadorRepositoryPostgres.save (the same
 * row the wizard's perfil.atualizar mutation would upsert) → the REAL
 * server-side derivation flips to needsOnboarding=false. No mocking.
 */
async function seedUser(opts: { onboarded: boolean }): Promise<SeededUser> {
  const db = createDatabase(DATABASE_URL);
  try {
    const deps = buildSeedDeps(db);

    // Unique suffix MUST live in the FIRST name token — the slug base is
    // derived from it (collision-walk gotcha, aperture-8jcec).
    const runSuffix = randomUUID().slice(0, 8);
    const nomeExibicao = `E2e${runSuffix} Helena`;
    const email = `e2e-test-${runSuffix}@e2e.local`;

    const { usuario, campanha } = await registrarContaUsuario(deps, {
      idUsuario: randomUUID() as never,
      idConta: randomUUID() as never,
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email,
      nomeExibicao,
      senhaSimulada: 'senha-e2e-teste-123',
    });

    // Attach a recebedor so the campanha is "complete" (mirrors
    // e2e/fixtures.ts — findByAdministrador otherwise resolves undefined
    // and the dashboard/campanhas surfaces render empty).
    const recebedor = criarRecebedorInicial({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: nomeExibicao,
        // Migration 20260709_036 requires cpf_titular NOT NULL on the
        // recebedores_variante_check constraint. Checksum-valid fake.
        cpfTitular: '11144477735',
        tipoChavePix: 'email',
        chavePix: email,
      },
      criadaEm: deps.clock(),
    });
    await deps.recebedorRepository.save(recebedor);

    if (opts.onboarded) {
      const perfil = criarPerfilCriador({
        id: randomUUID(),
        idUsuario: usuario.id,
        conteudo: { ...conteudoPerfilCriadorVazio(), nomeBebe: 'Helena' },
        criadoEm: deps.clock(),
      });
      await deps.perfilCriadorRepository.save(perfil);
    }

    const sessao = await criarSessaoUsuario(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email,
      senhaSimulada: 'senha-e2e-teste-123',
    });

    return { slug: usuario.slug, sessionToken: sessao.token };
  } finally {
    await db.destroy();
  }
}

/**
 * Context with the BetterAuth session cookie pre-set (byte-for-byte what the
 * OAuth callback leaves behind) + the /campanhas welcome-modal opt-out flag
 * pre-seeded so the modal never intercepts assertions (banked gotcha).
 */
async function openAuthedPage(
  browser: Browser,
  user: SeededUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const url = new URL(BASE_URL);
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: encodeURIComponent(user.sessionToken),
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript(
    ([key]) => window.localStorage.setItem(key, '1'),
    [CAMPANHAS_WELCOME_STORAGE_KEY],
  );
  const page = await context.newPage();
  return { context, page };
}

test.describe('8bac7 — post-login needsOnboarding routing gate (OAuth-return leg)', () => {
  test('OAuth return + needsOnboarding=true → lands /painel/:slug with the wizard BLOCKING', async ({
    browser,
  }) => {
    const user = await seedUser({ onboarded: false });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    // useOauthReturnRedirect fetches REAL auth.me → needsOnboarding=true
    // (no perfil row) → /painel/<slug>.
    await page.waitForURL(`**/painel/${user.slug}`);

    // The wizard blocks — PainelPage returns OnboardingWizard INSTEAD of the
    // dashboard branch.
    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();
    await expect(
      page.locator('.painel-menu-grid'),
      'dashboard chrome must NOT render while the wizard gate blocks',
    ).toHaveCount(0);

    await context.close();
  });

  test('OAuth return + onboarded user → lands /campanhas with the grid', async ({ browser }) => {
    const user = await seedUser({ onboarded: true });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    // REAL auth.me → perfil.nomeBebe set → needsOnboarding=false → /campanhas.
    await page.waitForURL('**/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();

    await context.close();
  });

  test('the ?oauth=1 marker is stripped and does not re-trigger', async ({ browser }) => {
    const user = await seedUser({ onboarded: true });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/campanhas');

    // Marker was stripped via history.replaceState on the landing BEFORE the
    // redirect — it must not survive into the final URL.
    expect(
      new URL(page.url()).searchParams.get('oauth'),
      'oauth marker must be stripped',
    ).toBeNull();

    // A reload must NOT bounce anywhere (no marker → no redirect loop).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe('/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();

    await context.close();
  });

  test('no marker → no redirect: authed user on the landing stays put', async ({ browser }) => {
    const user = await seedUser({ onboarded: true });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Guardrail under test: a logged-in user who navigates to the landing on
    // purpose is NOT force-redirected — the hook only fires on ?oauth=1.
    // 500ms grace covers hydration + the (absent) auth.me→assign hop.
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname, 'landing must not auto-redirect authed users').toBe('/');

    await context.close();
  });
});

test.describe('8bac7 — destination-side gate (PainelPage)', () => {
  test('direct /painel/:slug visit + needsOnboarding=true → wizard blocks there too', async ({
    browser,
  }) => {
    const user = await seedUser({ onboarded: false });
    const { context, page } = await openAuthedPage(browser, user);

    // No OAuth marker at all — the destination-side gate must hold on its
    // own (provider-agnostic: covers deep links, bookmarks, manual nav).
    await page.goto(`/painel/${user.slug}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();
    await expect(
      page.locator('.painel-menu-grid'),
      'dashboard chrome must NOT render behind the wizard',
    ).toHaveCount(0);

    await context.close();
  });

  test('onboarded user direct /painel/:slug → dashboard renders, NO wizard', async ({
    browser,
  }) => {
    const user = await seedUser({ onboarded: true });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto(`/painel/${user.slug}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('.painel-menu-grid')).toBeVisible();
    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toHaveCount(0);

    await context.close();
  });
});
