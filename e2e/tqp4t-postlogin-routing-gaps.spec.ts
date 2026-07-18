/**
 * aperture-tqp4t — post-login routing EDGE GAPS (companion to 8bac7).
 *
 * 8bac7 covers the three MAIN user-classes (fresh→wizard, onboarded→/campanhas,
 * legacy→/campanhas via g1wl4). This suite covers the four previously-UNCOVERED
 * edge gaps surfaced by the operator-found lrl1h bug + the w3rrd frontend
 * hardening:
 *
 *   GAP 1 (lrl1h / #29, ACTIVE) — multi-campanha, OLDEST blank but a NEWER
 *     campanha is named → the user has a usable list → lands /campanhas, NOT the
 *     wizard. The bug: needsOnboarding used to key off the OLDEST campanha's
 *     nomeBebe, so this user was wrongly wizard-walled. #29 keys off "has ANY
 *     named campanha" (perfil_campanhas), which this proves end-to-end.
 *
 *   GAP 4 (lrl1h / #29, ACTIVE) — the onboarding LATCH: once auth.me observes a
 *     named campanha it writes usuarios.onboarding_concluido_em; thereafter
 *     CLEARING nomeBebe (an editable field) must NOT re-fire the wizard. Proven
 *     by: onboard → observe (latch) → clear the name → the user still routes to
 *     /campanhas (latch holds), never back to the wizard.
 *
 *   GAP 2 (w3rrd, BUILD-AHEAD — gated on W3RRD_WIRED) — auth.me RACE: a logged-in
 *     user whose first auth.me resolves null/errors (cookie race, expiry) must
 *     still reach a DETERMINISTIC destination (/campanhas or the wizard), never
 *     be stranded on the landing. Today useOauthReturnRedirect swallows the
 *     failure and stays on the landing (line ~74); w3rrd adds the bounded retry /
 *     safe-redirect. These specs PIN that contract for Vance.
 *
 *   GAP 3 (w3rrd, BUILD-AHEAD — gated on W3RRD_WIRED) — DIRECT /campanhas nav by
 *     a non-legacy un-onboarded user must be PUSHED into the wizard. Today only
 *     PainelPage enforces the wizard; a direct /campanhas hit shows the NOVA-
 *     LISTA stub instead. w3rrd adds the CampanhasPage gate. Pinned here.
 *
 * HARNESS: mirrors 8bac7-postlogin-routing.spec.ts exactly — REAL server-derived
 * signals (no mocking of the needsOnboarding predicate), a real BetterAuth
 * session cookie + `/?oauth=1` to drive the real useOauthReturnRedirect leg, and
 * the same selectors. The ONLY simulated surface is GAP 2's transient auth.me
 * failure — and that induces a NETWORK degradation (a real race), it does not
 * fabricate a false derivation result.
 *
 * W3RRD_WIRED: flip to true once aperture-w3rrd (Vance's frontend fix) lands on
 * staging, then the GAP 2 + GAP 3 describes run + must go green. Until then they
 * are describe.skip so the suite stays green on #29 alone (the CampanhasPage gate
 * + the auth.me retry do not exist yet — asserting them now would be a false red).
 */

import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { PerfilCampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/perfil-campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { PerfilCriadorRepositoryPostgres } from '../src/adapters/usuario/perfil-criador-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarPerfilCampanha } from '../src/domain/arrecadacao/entities/perfil-campanha.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { conteudoPerfilCriadorVazio } from '../src/domain/usuario/value-objects/conteudo-perfil-criador.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { criarSessaoUsuario } from '../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';

/**
 * Flip to true when aperture-w3rrd lands on staging (auth.me retry/safe-redirect
 * + the CampanhasPage wizard-push gate). Until then GAP 2 + GAP 3 are skipped —
 * the behaviors they assert do not exist yet, so running them would be a false
 * red on #29 alone. The assertions below are the frozen contract for w3rrd.
 */
const W3RRD_WIRED = true;

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
  /** The user's OLDEST (auto-created) campanha id — the one seeds name/clear. */
  campanhaId: string;
}

/** Engine deps for the seed flow — mirrors 8bac7 buildSeedDeps. */
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

/** Attach a live PIX recebedor so a campanha is "complete" (mirrors 8bac7). */
async function attachRecebedor(
  deps: ReturnType<typeof buildSeedDeps>,
  idCampanha: string,
  nomeTitular: string,
  chavePix: string,
) {
  const recebedor = criarRecebedorInicial({
    id: randomUUID() as never,
    idCampanha: idCampanha as never,
    // cpf_titular is required on pix rows (migration 036 recebedores_variante_check).
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular,
      cpfTitular: '11144477735',
      tipoChavePix: 'email',
      chavePix,
    },
    criadaEm: deps.clock(),
  });
  await deps.recebedorRepository.save(recebedor);
}

/** Write a perfil_campanha with the given nomeBebe (null to CLEAR) — the exact
 *  row the wizard's perfilCampanha.atualizar mutation upserts, keyed by
 *  id_campanha (the #29 derivation source). No mocking. */
async function setNomeBebe(db: Database, idCampanha: string, nomeBebe: string | null) {
  const perfil = criarPerfilCampanha({
    id: randomUUID() as never,
    idCampanha: idCampanha as never,
    conteudo: { ...conteudoPerfilCriadorVazio(), nomeBebe },
    criadoEm: new Date(),
  });
  await new PerfilCampanhaRepositoryPostgres(db).save(perfil);
}

/**
 * Seed a user + session directly through the engine (no UI).
 *
 *  - nomearDefault:   name the OLDEST (auto-created) campanha → onboarded.
 *  - segundaNomeada:  create a NEWER campanha and name ONLY that one (GAP 1:
 *                     oldest blank, newer named → has a usable list).
 *
 * Returns the OLDEST campanha id so GAP 4 can clear it post-observe.
 */
async function seedUser(
  opts: { nomearDefault?: boolean; segundaNomeada?: boolean } = {},
): Promise<SeededUser> {
  const db = createDatabase(DATABASE_URL);
  try {
    const deps = buildSeedDeps(db);

    // Unique suffix MUST live in the FIRST name token — the slug base derives
    // from it (collision-walk gotcha, aperture-8jcec).
    const runSuffix = randomUUID().slice(0, 8);
    const nomeExibicao = `E2e${runSuffix} Helena`;
    const email = `e2e-tqp4t-${runSuffix}@e2e.local`;

    const { usuario, campanha } = await registrarContaUsuario(deps, {
      idUsuario: randomUUID() as never,
      idConta: randomUUID() as never,
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email,
      nomeExibicao,
      senhaSimulada: 'senha-e2e-teste-123',
    });
    await attachRecebedor(deps, campanha.id, nomeExibicao, email);

    if (opts.nomearDefault) {
      await setNomeBebe(db, campanha.id, 'Helena');
    }

    if (opts.segundaNomeada) {
      // A NEWER campanha owned by the same conta — named, while the oldest
      // (default) stays blank. This is the GAP-1 shape.
      const segunda = await criarCampanha(deps, {
        id: randomUUID() as never,
        idPlataforma: ID_PLATAFORMA_EUNENEM as never,
        idsAdministradores: [usuario.idConta] as never,
        titulo: 'Segundo bebê',
      });
      await attachRecebedor(deps, segunda.id, nomeExibicao, email);
      await setNomeBebe(db, segunda.id, 'Aurora');
    }

    const sessao = await criarSessaoUsuario(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email,
      senhaSimulada: 'senha-e2e-teste-123',
    });

    return { slug: usuario.slug, sessionToken: sessao.token, campanhaId: campanha.id };
  } finally {
    await db.destroy();
  }
}

/** Clear the OLDEST campanha's nomeBebe AFTER the browser observed it (GAP 4). */
async function clearNomeBebe(campanhaId: string) {
  const db = createDatabase(DATABASE_URL);
  try {
    await setNomeBebe(db, campanhaId, null);
  } finally {
    await db.destroy();
  }
}

/** Context with the BetterAuth session cookie pre-set + the /campanhas
 *  welcome-modal opt-out (so the modal never intercepts assertions). */
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

// ═══════════════════════════════════════════════════════════════════════════
// GAP 1 — multi-campanha, oldest blank + newer named → /campanhas (#29, ACTIVE)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('tqp4t GAP 1 — multi-campanha oldest-blank-newer-named (lrl1h)', () => {
  test('OAuth return: oldest campanha blank but a NEWER campanha named → /campanhas, NOT the wizard', async ({
    browser,
  }) => {
    const user = await seedUser({ segundaNomeada: true });
    const { context, page } = await openAuthedPage(browser, user);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    // REAL auth.me → temCampanhaNomeada=true (the NEWER campanha) → needsOnboarding
    // =false even though the oldest is blank → /campanhas.
    await page.waitForURL('**/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: WIZARD_LABEL }),
      'a user with a named (newer) list must NOT be wizard-walled',
    ).toHaveCount(0);

    await context.close();
  });

  test('direct /painel/:slug: oldest blank + newer named → dashboard renders, NO wizard', async ({
    browser,
  }) => {
    const user = await seedUser({ segundaNomeada: true });
    const { context, page } = await openAuthedPage(browser, user);

    // Destination-side gate (PainelPage) must also read the has-ANY-named signal.
    await page.goto(`/painel/${user.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.painel-menu-grid')).toBeVisible();
    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toHaveCount(0);

    await context.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GAP 4 — onboarding LATCH: clearing nomeBebe does NOT re-fire wizard (#29, ACTIVE)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('tqp4t GAP 4 — onboarding latch survives a nomeBebe clear (lrl1h)', () => {
  test('onboard → observe (latch) → clear nomeBebe → still routes /campanhas, wizard does NOT re-fire', async ({
    browser,
  }) => {
    const user = await seedUser({ nomearDefault: true });
    const { context, page } = await openAuthedPage(browser, user);

    // 1. First observe — auth.me sees a named campanha → routes /campanhas AND
    //    writes usuarios.onboarding_concluido_em (the latch, awaited server-side
    //    before the response).
    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();

    // 2. Now CLEAR the baby name via the editable profile field.
    await clearNomeBebe(user.campanhaId);

    // 3. Re-run the real gate. temCampanhaNomeada is now false, but the latch
    //    (onboarding_concluido_em) is set → needsOnboarding stays false → the
    //    user must STILL land /campanhas, never be bounced back to the wizard.
    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: WIZARD_LABEL }),
      'clearing an editable nomeBebe must NOT un-onboard a latched user',
    ).toHaveCount(0);

    await context.close();
  });

  test('destination-side: after latch + clear, direct /painel/:slug shows the dashboard (no wizard)', async ({
    browser,
  }) => {
    const user = await seedUser({ nomearDefault: true });
    const { context, page } = await openAuthedPage(browser, user);

    // Latch via a first observe on the destination-side gate.
    await page.goto(`/painel/${user.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.painel-menu-grid')).toBeVisible();

    await clearNomeBebe(user.campanhaId);

    // Latch holds — the dashboard still renders, the wizard does not reappear.
    await page.goto(`/painel/${user.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.painel-menu-grid')).toBeVisible();
    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toHaveCount(0);

    await context.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GAP 2 — auth.me RACE → deterministic destination (w3rrd, BUILD-AHEAD)
// ═══════════════════════════════════════════════════════════════════════════
const describeW3rrd = W3RRD_WIRED ? test.describe : test.describe.skip;

describeW3rrd('tqp4t GAP 2 — auth.me race → deterministic destination (w3rrd)', () => {
  /** Fail the FIRST /api/trpc/auth.me call (a transient race), then let every
   *  subsequent call through untouched — this induces a NETWORK degradation, it
   *  does not fabricate a derivation result. w3rrd's bounded retry must recover. */
  async function failFirstAuthMe(page: Page) {
    let failed = false;
    await page.route('**/api/trpc/auth.me*', async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.continue();
    });
  }

  test('onboarded user + first auth.me 503 → retry lands /campanhas, never stuck on landing', async ({
    browser,
  }) => {
    const user = await seedUser({ nomearDefault: true });
    const { context, page } = await openAuthedPage(browser, user);
    await failFirstAuthMe(page);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    // w3rrd: the bounded retry re-fetches auth.me → onboarded → /campanhas.
    await page.waitForURL('**/campanhas');
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    expect(new URL(page.url()).pathname, 'must not be stranded on the landing').not.toBe('/');

    await context.close();
  });

  test('un-onboarded user + first auth.me 503 → retry lands the wizard, never stuck on landing', async ({
    browser,
  }) => {
    const user = await seedUser({});
    const { context, page } = await openAuthedPage(browser, user);
    await failFirstAuthMe(page);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`**/painel/${user.slug}`);
    await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();

    await context.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GAP 3 — direct /campanhas nav by non-legacy un-onboarded → wizard push (w3rrd)
// ═══════════════════════════════════════════════════════════════════════════
describeW3rrd(
  'tqp4t GAP 3 — direct /campanhas nav pushes an un-onboarded user to the wizard (w3rrd)',
  () => {
    test('non-legacy un-onboarded user navigating DIRECTLY to /campanhas is pushed into the wizard', async ({
      browser,
    }) => {
      const user = await seedUser({}); // fresh, no named campanha → needsOnboarding
      const { context, page } = await openAuthedPage(browser, user);

      // Entry point is /campanhas directly (deep link / bookmark) — NOT the
      // post-login redirect. w3rrd's CampanhasPage gate must push to the wizard.
      await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });

      // Either redirected to /painel/:slug (where the wizard blocks) or the wizard
      // mounts over /campanhas — in both shapes the wizard is visible and the
      // NOVA-LISTA stub is NOT the terminal state.
      await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();

      await context.close();
    });

    test('onboarded user navigating directly to /campanhas renders the grid (no wizard push)', async ({
      browser,
    }) => {
      const user = await seedUser({ nomearDefault: true });
      const { context, page } = await openAuthedPage(browser, user);

      await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('campanhas-grid')).toBeVisible();
      await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toHaveCount(0);

      await context.close();
    });
  },
);
