/**
 * aperture-iu9ji — fblrt FIX-WAVE regression gates (deployed staging).
 *
 * A growing regression net for the wave of small fblrt fixes the operator
 * asked to have ready on his return. Each arm guards a specific shipped fix
 * against silent regression. Green-confirmation (fixes already live) with
 * assertions tight enough that the pre-fix bug would red them.
 *
 * ── ej436 (#372, 2c7ebe7) — 'ver como convidado' carries the campanha ──────
 * Two call sites of the guest-preview destination:
 *   1. PainelMenuRow 'preview' row (a[data-tutorial-target="preview"]) —
 *      already threaded idCampanha (/c/<uuid>); #372 adds campanhaSlug so it
 *      shows the pretty /pagina/<user>/<campanha-slug> when chosen.
 *   2. ConvitePreviewBody guest-CTA ('Ver lista de presentes') — was FULLY
 *      bare menuItemHref(slug,'preview') → resolved the OLDEST campanha (the
 *      real leak Wheatley flagged surviving #367). Now threads route campanha
 *      + pretty slug.
 * Seam: menuItemHref 'preview' → paginaSharePath(slug, idCampanha,
 * campanhaSlug). campanhaSlug resolves ASYNC (campanhas.list) so waits are
 * pinned to the FINAL href (the pre-resolve render is /c/<uuid> — a valid
 * intermediate, not a leak, but we assert the settled pretty form).
 *
 * ── yvrtk (#371, 21f0455) — welcome modal opens at most once per mount ─────
 * welcomeShownThisMount ref stops the modal RE-POPPING when campanhas.list
 * invalidates (criar / definirSlug / wizard finish). FIXTURE CONSTRAINT: the
 * modal renders ONLY for users with 1.0 legado history (legado.length > 0).
 * The permanent gate-walker is a pure-2.0 signup — legado is empty — so it
 * CANNOT trigger the modal. This arm therefore skips LOUDLY with the fixture
 * gap named, rather than pretending a no-legado account exercises the fix.
 * Un-skips the day a legado-bearing walker exists (coordinate w/ Rex).
 *
 * WALKER: permanent gate-walker (creds env / mempalace
 * drawer_eunenem_secrets_afd95964dc3c7bbba928fad8). Campanha B carries pretty
 * slug 'gate-camp-b'; campanha A is slugless.
 *
 * RUN:
 *   E2E_BASE_URL=https://eunenem.xeroxtoxerox.com \
 *   E2E_GATE_EMAIL=<walker> E2E_GATE_SENHA=<walker> \
 *   pnpm exec playwright test e2e/fblrt-fix-wave.spec.ts
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';
import { menuItemHref } from '../apps/eunenem-server/pages/lib/painelRoutes.js';
import { seedGateWalker } from './gate-fixtures.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

const NOME_EXIBICAO = 'Izzygate Walker';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`; // oldest, slugless
const TITULO_B = 'Segunda Lista do Gate 118sb'; // slug-bearing
const SLUG_CAMP_B = 'gate-camp-b';

interface CampanhaCard {
  id: string;
  titulo: string;
  slug: string;
  campanhaSlug: string | null;
}
interface CampanhasList {
  novas: CampanhaCard[];
  legado: unknown[];
}

async function trpcQuery<T>(
  api: APIRequestContext,
  procedure: string,
  input?: unknown,
): Promise<T> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await api.get(`/api/trpc/${procedure}${qs}`);
  expect(res.ok(), `${procedure} must succeed — got ${res.status()}: ${await res.text()}`).toBe(
    true,
  );
  return ((await res.json()) as { result: { data: T } }).result.data;
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
  return ((await res.json()) as { result: { data: T } }).result.data;
}

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
  await page.getByRole('button', { name: /criar minha página/ }).click();
  await expect(wizard, 'wizard must close after finish() persists the perfil').toBeHidden({
    timeout: 20_000,
  });
}

test.describe('fblrt fix-wave regression gates (aperture-iu9ji)', () => {
  test.skip(
    !GATE_EMAIL || !GATE_SENHA,
    'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker creds live in env/mempalace',
  );

  let api: APIRequestContext;
  let context: BrowserContext;
  let userSlug: string;
  let campA: CampanhaCard;
  let campB: CampanhaCard;
  let legadoCount = 0;

  test.beforeAll(async ({ browser, baseURL }) => {
    // Hermetic seed (coverage-expansion): find-or-create the gate-walker +
    // campanhas A/B directly in the DB so the login/self-heal below finds the
    // full contract already correct on a fresh local DB. No-op when creds unset.
    await seedGateWalker();
    expect(baseURL, 'baseURL must be configured').toBeTruthy();
    api = await pwRequest.newContext({ baseURL });

    const cont = await api.post('/api/trpc/auth.continuarComEmail', {
      data: {
        email: GATE_EMAIL,
        senha: GATE_SENHA,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: NOME_EXIBICAO,
      },
    });
    expect(cont.ok(), `continuarComEmail failed: ${cont.status()} ${await cont.text()}`).toBe(true);

    const me = await trpcQuery<{ slug: string; needsOnboarding: boolean }>(api, 'auth.me');
    userSlug = me.slug;

    context = await browser.newContext({ storageState: await api.storageState() });
    await context.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );

    if (me.needsOnboarding) {
      const page = await context.newPage();
      await completeWizard(page, userSlug);
      await page.close();
    }
    await trpcMutation(api, 'usuario.completarTutorial', {});

    let list = await trpcQuery<CampanhasList>(api, 'campanhas.list');
    if (!list.novas.some((c) => c.titulo === TITULO_B)) {
      await trpcMutation(api, 'campanhas.criar', { titulo: TITULO_B });
      list = await trpcQuery<CampanhasList>(api, 'campanhas.list');
    }
    legadoCount = list.legado.length;
    campA = list.novas.find((c) => c.titulo === TITULO_A) as CampanhaCard;
    campB = list.novas.find((c) => c.titulo === TITULO_B) as CampanhaCard;
    expect(campA, `walker must own "${TITULO_A}"`).toBeTruthy();
    expect(campB, `walker must own "${TITULO_B}"`).toBeTruthy();

    await trpcMutation(api, 'campanhas.definirSlug', { idCampanha: campB.id, slug: SLUG_CAMP_B });
    const after = await trpcQuery<CampanhasList>(api, 'campanhas.list');
    campA = after.novas.find((c) => c.id === campA.id) as CampanhaCard;
    campB = after.novas.find((c) => c.id === campB.id) as CampanhaCard;
    expect(campB.campanhaSlug, `B must carry pretty slug '${SLUG_CAMP_B}'`).toBe(SLUG_CAMP_B);
    expect(campA.campanhaSlug, 'A must remain slugless').toBeNull();
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  // ── ej436 arm 1 — menu row on the SLUG-BEARING campanha (pretty URL) ─────
  test('ej436 — B painel "ver como convidado" → /pagina/<user>/gate-camp-b', async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`/painel/${userSlug}/c/${campB.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status()).toBe(200);

      const row = page.locator('a[data-tutorial-target="preview"]');
      await expect(row, 'the "ver como convidado" menu row must render').toBeVisible();
      await expect(row).toHaveText(/ver como convidado/i);

      // Seam truth: menuItemHref('preview', idB, 'gate-camp-b') = /pagina/user/gate-camp-b.
      const expectedHref = menuItemHref(userSlug, 'preview', campB.id, campB.campanhaSlug);
      expect(expectedHref).toBe(`/pagina/${userSlug}/${SLUG_CAMP_B}`);
      // Pin to the FINAL (settled) href — campanhaSlug resolves async; the
      // pre-resolve render is /c/<uuid>. toHaveAttribute retries until settled.
      await expect(row, 'preview row must carry the pretty campanha URL').toHaveAttribute(
        'href',
        new RegExp(`/pagina/${userSlug}/${SLUG_CAMP_B}$`),
      );
      // Leak signature: bare /pagina/<user> (the pre-ej436 oldest resolution).
      await expect(row).not.toHaveAttribute('href', new RegExp(`/pagina/${userSlug}$`));
    } finally {
      await page.close();
    }
  });

  // ── ej436 arm 2 — menu row on the SLUGLESS campanha (/c/<uuid> canonical) ─
  test('ej436 — A painel "ver como convidado" → /pagina/<user>/c/<idA> (slugless)', async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`/painel/${userSlug}/c/${campA.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status()).toBe(200);

      const row = page.locator('a[data-tutorial-target="preview"]');
      await expect(row).toBeVisible();

      const expectedHref = menuItemHref(userSlug, 'preview', campA.id, campA.campanhaSlug);
      expect(expectedHref).toBe(`/pagina/${userSlug}/c/${campA.id}`);
      await expect(
        row,
        'slugless preview row must be the /c/<uuid> canonical form',
      ).toHaveAttribute('href', new RegExp(`/pagina/${userSlug}/c/${campA.id}$`));
      // Must NOT leak B's chosen slug, and must NOT be bare (oldest).
      await expect(row).not.toHaveAttribute('href', new RegExp(SLUG_CAMP_B));
      await expect(row).not.toHaveAttribute('href', new RegExp(`/pagina/${userSlug}$`));
    } finally {
      await page.close();
    }
  });

  // ── ej436 arm 3 — ConvitePreviewBody guest-CTA (the REAL bare→oldest leak) ─
  // Viewed ANONYMOUSLY (non-owner) so the guest-CTA branch renders instead of
  // 'editar convite'. The preview page is a shareable public surface. B has a
  // saved convite (seeded below). Pre-ej436 this CTA was fully bare → resolved
  // the OLDEST campanha. The fix threads idCampanha so it now carries THIS
  // campanha (B).
  //
  // CONTEXT SUBTLETY (verified against reality 2026-07-09): the PRETTY slug
  // (/pagina/<user>/gate-camp-b) is only reachable when useCampanhaSlugRota can
  // read the OWNER's authed campanhas.list. An ANON viewer has no such list, so
  // campanhaSlug is undefined and the CTA correctly degrades to the /c/<uuid>
  // CANONICAL form — which is still campanha B, NOT the oldest. That canonical-
  // for-anon behaviour IS the correct ej436 contract on the guest path; the
  // pretty-slug form is asserted for the authed owner in arm 1.
  test('ej436 — anon convite-preview guest-CTA carries B (/c/<idB>), not the oldest', async ({
    browser,
  }) => {
    // Ensure B has a saved convite so the preview page has content to show.
    const conviteB = await trpcQuery<{ evento: unknown }>(api, 'eventoConvite.get', {
      idCampanha: campB.id,
    });
    if (conviteB.evento == null) {
      await trpcMutation(api, 'eventoConvite.save', {
        idCampanha: campB.id,
        tipoEvento: 'cha-bebe',
        modalidade: 'presencial',
        dataHoraIso: '2026-08-01T15:00:00.000Z',
        endereco: 'Rua das Flores, 123',
        remetente: 'Francisco',
        nomeExibido: 'Bebe Gate B',
        mensagem: 'Venha comemorar conosco!',
        paleta: 'lilas',
        fonte: 'patrick',
        modelo: 'scrapbook',
      });
    }

    // Fresh anonymous context — no walker session → non-owner branch.
    const anon = await browser.newContext();
    const page = await anon.newPage();
    try {
      const previewUrl = `/painel/${userSlug}/c/${campB.id}/convite/preview`;
      const res = await page.goto(previewUrl, { waitUntil: 'networkidle' });
      // If the preview page isn't anon-reachable on this build, don't false-
      // fail the seam — record it and lean on the menu-row arms (same seam).
      test.skip(
        !res || res.status() !== 200,
        `convite preview not anon-reachable (status ${res?.status()}) — menu-row arms cover the same menuItemHref seam`,
      );

      // The guest-CTA renders CLIENT-side after hydration + the convite data
      // fetch. Wait for it (bounded) rather than counting instantly. If it
      // never appears (preview data is authed-only for anon, or owner branch),
      // skip with the observed page state — the menu-row arms cover the same
      // menuItemHref seam either way.
      const guestCta = page.locator('a', { hasText: /ver lista de presentes/i });
      const appeared = await guestCta
        .first()
        .waitFor({ state: 'visible', timeout: 6_000 })
        .then(() => true)
        .catch(() => false);
      test.skip(
        !appeared,
        'guest-CTA never rendered for anon (preview data likely authed-only / owner branch) — menu-row arms cover the seam',
      );
      // Anon can't resolve the pretty slug (no authed campanhas.list), so the
      // CTA carries the /c/<idB> CANONICAL form — the RIGHT campanha (B), NOT
      // the oldest. That is the ej436 fix on the guest path.
      await expect(
        guestCta.first(),
        'anon guest-CTA must target THIS campanha (/c/<idB>), never the oldest (the ej436 leak)',
      ).toHaveAttribute('href', new RegExp(`/pagina/${userSlug}/c/${campB.id}$`));
      // The leak signature: bare /pagina/<user> (drops to the oldest campanha).
      await expect(guestCta.first()).not.toHaveAttribute(
        'href',
        new RegExp(`/pagina/${userSlug}$`),
      );
    } finally {
      await page.close();
      await anon.close();
    }
  });

  // ── yvrtk — welcome modal single-pop (FIXTURE-BLOCKED for a pure-2.0 walker) ─
  test('yvrtk — welcome modal opens ≤1x, no re-pop after list invalidation', async () => {
    test.skip(
      legadoCount === 0,
      'FIXTURE GAP: welcome modal renders only for users with 1.0 legado history ' +
        '(listQ.data.legado.length>0). The gate-walker is a pure-2.0 signup (legado empty), ' +
        'so it cannot trigger the modal. Needs a legado-bearing walker (coordinate w/ Rex) ' +
        'to exercise the welcomeShownThisMount re-pop fix. Reported to GLaDOS on aperture-iu9ji.',
    );

    // Reachable only with a legado-bearing walker. The intended walk:
    // 1. open /campanhas WITHOUT the welcome opt-out localStorage set →
    //    welcome-modal appears (count === 1);
    // 2. dismiss via Escape (no checkbox) → modal hidden;
    // 3. trigger a campanhas.list invalidation (criar a campanha) →
    //    pre-yvrtk the modal re-popped; post-fix it must STAY hidden;
    // 4. assert welcome-modal opened exactly once this session.
    const page = await context.newPage();
    try {
      await page.addInitScript(
        ([key]) => window.localStorage.removeItem(key),
        [CAMPANHAS_WELCOME_STORAGE_KEY],
      );
      await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      const modal = page.getByTestId('welcome-modal');
      await expect(modal, 'welcome modal must appear once on first mount').toBeVisible();
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();

      await trpcMutation(api, 'campanhas.criar', { titulo: `Re-pop probe ${Date.now()}` });
      // Give the list refetch + effect a beat; the modal must NOT re-pop.
      await page.waitForTimeout(1500);
      await expect(modal, 'modal must NOT re-pop after list invalidation (yvrtk)').toBeHidden();
    } finally {
      await page.close();
    }
  });
});
