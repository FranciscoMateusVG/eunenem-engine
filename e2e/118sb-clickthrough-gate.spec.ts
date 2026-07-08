/**
 * aperture-118sb — THE CLICK-THROUGH GATE for Bug 2 (aperture-snfin).
 *
 * WHY THIS EXISTS: Bug 2 (per-campanha routing) shipped "fixed" TWICE on
 * bundle-marker verification without an actual click-through — the route
 * plumbing was correct (each 2.0 card hrefs /painel/:slug/c/:idCampanha,
 * aperture-h0hom) but the painel DATA layer ignored the route id
 * (ExtratoStubData.useStubCampanhaIdForSlug returns auth.me's default
 * campanha, slug/route unused), so both cards opened the SAME painel.
 * The operator caught it live. This spec is the hard gate: aperture-snfin
 * does NOT close until this is green on the DEPLOYED app.
 *
 * GATE SEMANTICS (red-first): on today's stub behavior this spec MUST FAIL
 * (the identity chip does not exist yet, and if it did the stub would show
 * the default campanha on both painels). It passes only when snfin actually
 * wires the painel identity to the clicked campanha.
 *
 * SELECTOR CONTRACT (locked with Vance, msg 1783544295283):
 *   - data-testid="painel-campanha-titulo" — identity chip in the
 *     PainelHeaderCard title row. textContent === the campanha titulo
 *     EXACTLY (the string typed in NOVA LISTA / minted at signup).
 *   - Present on BOTH routes: /painel/:slug/c/:id shows the CLICKED
 *     campanha's titulo; bare /painel/:slug shows the OLDEST campanha's.
 *   - While campanhas.list is pending the chip renders '…' — final-text
 *     assertions with Playwright auto-wait handle that.
 *   - The h1 ("página da <bebê>") is per-USER (perfil nomeBebe) and
 *     identical across campanhas — never assert identity on it.
 *
 * DEPLOYMENT REALITY (verified 2026-07-08, see bead aperture-118sb +
 * bd memory eunenem-staging-prod-dual-homed-2026-07-08):
 * eunenem.xeroxtoxerox.com and app.eunenem.com are DUAL-HOMED onto one
 * container + one postgres. Writes against "staging" land in the
 * prod-serving DB. Therefore this spec uses a PERMANENT, IDEMPOTENT
 * gate-walker user (incluir o0kt/9yaa precedent) instead of per-run junk
 * accounts:
 *   - auth.continuarComEmail (login-or-signup) with fixed credentials
 *     from env — first run creates the walker (+ auto campanha A
 *     "Lista de <nomeExibicao>"), completes the onboarding wizard via
 *     the real UI, and creates campanha B via campanhas.criar.
 *   - Every later run is a pure login + read-only click-through.
 *   - Total permanent footprint: 1 user + 2 campanhas, deterministic
 *     titles. Credentials live in env / mempalace, NEVER in this file.
 *
 * RUN (against the deployed app):
 *   E2E_BASE_URL=https://eunenem.xeroxtoxerox.com \
 *   E2E_GATE_EMAIL=<walker email> E2E_GATE_SENHA=<walker senha> \
 *   pnpm exec playwright test e2e/118sb-clickthrough-gate.spec.ts
 * (playwright.config.ts skips the local webServer when E2E_BASE_URL is
 * remote.) Also runs against local dev unchanged — the walker pattern is
 * deployment-agnostic.
 *
 * AUTH POSTURE NOTE: /api/auth/sign-{up,in}/email are 410 (deny-by-default)
 * on the deployed build; the tRPC procedures auth.continuarComEmail /
 * campanhas.criar are the supported scriptable surface (probed live,
 * rate-limited 10/min/(ip,email) — fine at test cadence).
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

/** Walker identity — deterministic so re-runs are read-only. Signup
 *  auto-creates campanha A titled `Lista de <NOME_EXIBICAO>`. */
const NOME_EXIBICAO = 'Izzygate Walker';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`;
const TITULO_B = 'Segunda Lista do Gate 118sb';

interface CampanhaNova {
  id: string;
  slug: string;
  titulo: string;
}

/** Plain-JSON tRPC helpers — this app registers NO transformer, so the
 *  envelope is `{result:{data:<output>}}` and mutation input is the raw
 *  JSON body (non-batch). */
async function trpcQuery<T>(api: APIRequestContext, procedure: string): Promise<T> {
  const res = await api.get(`/api/trpc/${procedure}`);
  expect(res.ok(), `${procedure} must succeed — got ${res.status()}: ${await res.text()}`).toBe(
    true,
  );
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

async function trpcMutation<T>(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<T> {
  const res = await api.post(`/api/trpc/${procedure}`, { data: input });
  expect(res.ok(), `${procedure} must succeed — got ${res.status()}: ${await res.text()}`).toBe(
    true,
  );
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

/** Complete the onboarding wizard through the real UI (first run only).
 *  Selectors per OnboardingWizard.tsx: #ob-name/#ob-baby → #ob-date/
 *  #ob-type/#ob-genero → keep the default slug → submit. */
async function completeWizard(page: Page, slug: string): Promise<void> {
  await page.goto(`/painel/${slug}`, { waitUntil: 'domcontentloaded' });
  const wizard = page.getByRole('dialog', { name: 'Vamos montar sua página' });
  await expect(wizard, 'fresh walker must be gated by the onboarding wizard').toBeVisible();

  await page.locator('#ob-name').fill(NOME_EXIBICAO);
  await page.locator('#ob-baby').fill('Bebe Gate');
  await page.getByRole('button', { name: /próximo/ }).click();

  await page.locator('#ob-date').fill('2030-01-01');
  await page.locator('#ob-type').selectOption('cha-bebe');
  await page.locator('#ob-genero').selectOption('surpresa');
  await page.getByRole('button', { name: /próximo/ }).click();

  // Keep the signup-derived slug — avoids the atualizarSlug path.
  await page.getByRole('button', { name: /criar minha página/ }).click();
  // finish() runs perfil.atualizar then onDone → window.location.assign to
  // the SAME /painel/<slug> URL we are already on. waitForURL here would
  // match INSTANTLY (tautology) and a subsequent page.close() kills the
  // in-flight mutations — exactly the harness bug that wizard-looped the
  // walker on the first bootstrap (banked 2026-07-08). Wait on OBSERVABLE
  // state instead: the wizard only stays gone post-reload if the perfil
  // actually persisted (needsOnboarding flipped false).
  await expect(wizard, 'wizard must close after finish() persists the perfil').toBeHidden({
    timeout: 20_000,
  });
}

test.describe
  .serial('/campanhas → painel click-through gate (aperture-118sb)', () => {
    test.skip(
      !GATE_EMAIL || !GATE_SENHA,
      'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker credentials live in env/mempalace, see spec header',
    );

    let api: APIRequestContext;
    let context: BrowserContext;
    let slug: string;
    let campanhaA: CampanhaNova; // oldest — minted at walker signup
    let campanhaB: CampanhaNova; // second — campanhas.criar

    test.beforeAll(async ({ browser, baseURL }) => {
      expect(baseURL, 'baseURL must be configured').toBeTruthy();
      api = await pwRequest.newContext({ baseURL });

      // Login-or-signup — idempotent by design. `criado` tells us whether
      // this run bootstraps or reuses the permanent walker.
      const cont = await api.post('/api/trpc/auth.continuarComEmail', {
        data: {
          email: GATE_EMAIL,
          senha: GATE_SENHA,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          nomeExibicao: NOME_EXIBICAO,
        },
      });
      expect(
        cont.ok(),
        `continuarComEmail must succeed — got ${cont.status()}: ${await cont.text()}`,
      ).toBe(true);

      const me = await trpcQuery<{ slug: string; needsOnboarding: boolean }>(api, 'auth.me');
      slug = me.slug;
      expect(slug, 'walker must have a slug (derived at signup)').toBeTruthy();

      // Browser context carries the walker session + pre-dismissed welcome
      // modal (hydration-race gotcha: the modal mounts after campanhas.list
      // resolves and intercepts clicks — pre-seed BEFORE any goto).
      context = await browser.newContext({ storageState: await api.storageState() });
      await context.addInitScript(
        ([key]) => window.localStorage.setItem(key, '1'),
        [CAMPANHAS_WELCOME_STORAGE_KEY],
      );

      // First run only: the wizard gates the painel until perfil exists.
      if (me.needsOnboarding) {
        const page = await context.newPage();
        await completeWizard(page, slug);
        // DB-truth belt-and-suspenders: the wizard's finish() catch branch
        // fires onDone even when perfil.atualizar FAILS (only a toast). If
        // needsOnboarding didn't flip, every painel visit re-blocks on the
        // wizard and the gate reds for the WRONG reason — fail loudly here.
        const me2 = await trpcQuery<{ needsOnboarding: boolean }>(api, 'auth.me');
        expect(
          me2.needsOnboarding,
          'wizard walk must persist the perfil (nomeBebe) — needsOnboarding still true',
        ).toBe(false);
        await page.close();
      }

      // First run only: mint campanha B (contract already E2E-covered by
      // e2e/u38rz-nova-lista-create.spec.ts — bootstrap uses tRPC directly).
      let list = await trpcQuery<{ novas: CampanhaNova[] }>(api, 'campanhas.list');
      if (!list.novas.some((c) => c.titulo === TITULO_B)) {
        await trpcMutation(api, 'campanhas.criar', { titulo: TITULO_B });
        list = await trpcQuery<{ novas: CampanhaNova[] }>(api, 'campanhas.list');
      }

      const a = list.novas.find((c) => c.titulo === TITULO_A);
      const b = list.novas.find((c) => c.titulo === TITULO_B);
      expect(
        a,
        `walker must own campanha A "${TITULO_A}" — got: ${JSON.stringify(list.novas)}`,
      ).toBeTruthy();
      expect(b, `walker must own campanha B "${TITULO_B}"`).toBeTruthy();
      campanhaA = a as CampanhaNova;
      campanhaB = b as CampanhaNova;
      expect(campanhaA.id, 'the two campanhas must be distinct rows').not.toBe(campanhaB.id);
    });

    test.afterAll(async () => {
      await context?.close();
      await api?.dispose();
    });

    /** The identity chip — Vance's snfin contract. Missing today (that IS
     *  Bug 2 unfixed); shows the displayed campanha's titulo post-fix. */
    function identityChip(page: Page) {
      return page.getByTestId('painel-campanha-titulo');
    }

    async function gotoCampanhas(page: Page): Promise<void> {
      const res = await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      expect(res?.status(), '/campanhas must resolve 200 for the authed walker').toBe(200);
      await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    }

    function card(page: Page, titulo: string) {
      return page.getByTestId('card-campanha').filter({ hasText: titulo });
    }

    test('core gate: card A → painel identifies A; card B → painel identifies B; painels differ', async () => {
      const page = await context.newPage();
      await gotoCampanhas(page);

      // Plumbing sanity (passes today — aperture-h0hom): each card hrefs its
      // OWN campanha. If this fails, the regression is UPSTREAM of snfin.
      await expect(card(page, TITULO_A)).toBeVisible();
      await expect(card(page, TITULO_B)).toBeVisible();
      await expect(card(page, TITULO_A).locator('a.camp-cta')).toHaveAttribute(
        'href',
        `/painel/${campanhaA.slug}/c/${campanhaA.id}`,
      );
      await expect(card(page, TITULO_B).locator('a.camp-cta')).toHaveAttribute(
        'href',
        `/painel/${campanhaB.slug}/c/${campanhaB.id}`,
      );

      // ── Card A → painel must IDENTIFY campanha A ──────────────────────
      await card(page, TITULO_A).locator('a.camp-cta').click();
      await page.waitForURL(new RegExp(`/painel/${campanhaA.slug}/c/${campanhaA.id}$`));
      await expect(
        identityChip(page),
        'painel must carry the campanha identity chip (data-testid=painel-campanha-titulo). ' +
          'ABSENT = Bug 2 unfixed: the painel data layer ignores the route idCampanha ' +
          '(ExtratoStubData stubs resolve auth.me default) — aperture-snfin not landed.',
      ).toBeVisible();
      await expect(identityChip(page)).toHaveText(TITULO_A);

      // ── Back → card B → painel must IDENTIFY campanha B ───────────────
      await gotoCampanhas(page);
      await card(page, TITULO_B).locator('a.camp-cta').click();
      await page.waitForURL(new RegExp(`/painel/${campanhaB.slug}/c/${campanhaB.id}$`));
      await expect(identityChip(page)).toBeVisible();
      await expect(identityChip(page)).toHaveText(TITULO_B);

      // ── The core Bug 2 assertion, explicit: the two painels are NOT the
      // same painel. (Subsumed by the exact-titulo asserts above, kept
      // explicit because THIS is the bead's reason to exist.)
      const shownOnB = (await identityChip(page).textContent())?.trim();
      expect(
        shownOnB,
        'clicking two distinct cards must yield two distinct painel identities — ' +
          'identical identity = both cards resolve the default campanha (Bug 2)',
      ).not.toBe(TITULO_A);
      await page.close();
    });

    test('regression: bare /painel/:slug (no /c/:id) resolves the OLDEST campanha', async () => {
      const page = await context.newPage();
      const res = await page.goto(`/painel/${slug}`, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), 'bare painel URL must resolve 200').toBe(200);

      // Oldest = campanha A (minted at walker signup, strictly older than B).
      // A shared bare link must NOT swap targets because a 2nd campanha exists.
      await expect(
        identityChip(page),
        'identity chip must exist on the bare route too (snfin contract: bare shows oldest)',
      ).toBeVisible();
      await expect(identityChip(page)).toHaveText(TITULO_A);
      await page.close();
    });
  });
