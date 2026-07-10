/**
 * aperture-al8c0 — SLUG / SHARE-LINK ISOLATION gate for the fblrt epic.
 *
 * Guards Vance's #367 (merged 7a1c928, deployed) — the LAST un-isolated
 * painel surface. Operator clean-slate walk 2026-07-09: every campanha's
 * painel share chip read the SAME /pagina/francisco, even 'Sera q eh
 * diferente' which had its OWN slug 'teste'. Sharing any campanha sent
 * guests to the wrong (oldest) page.
 *
 * #367 fixes, all through the pagina-share seam (painelRoutes.ts):
 *   P0(a) PainelHeaderCard chip renders paginaShareDisplayPath(slug,
 *         campanhaSlug) → 'francisco/teste' for a slug-bearing campanha,
 *         bare 'francisco' for a slugless one (uuid stays out of the pill;
 *         the href carries the full addressing).
 *   P0(b) convite native share threads idCampanha through
 *         buildConvitePreviewShareUrl → painelConvitePreviewHref — was
 *         leaking every share to the OLDEST campanha's preview.
 *   P1    5 context-dropping guest links (navbar brand, sucesso back-links,
 *         RSVP CTA, checkout sucesso URLs) routed through the same seam.
 *   NULL-slug: slugless campanha → /c/<uuid> canonical (working-as-designed).
 *
 * WHY THIS IS A GREEN-CONFIRMATION, NOT RED-FIRST: the fix is already live
 * on deployed staging, so we cannot red-first here. Instead every assertion
 * is TIGHT enough that the PRE-#367 behaviour (every chip collapsing to the
 * bare user-slug) would have RED it — e.g. B's chip MUST read
 * '<user>/gate-camp-b', which the old bare-'<user>' display fails.
 *
 * RESILIENCE TO THE INCOMING TOP-LEVEL REDESIGN (Wheatley qjs001, not yet
 * shipped): the load-bearing invariant here is the ISOLATION SEMANTICS —
 * campanha B's surfaces carry B's identity and NEVER a sibling's (S_CROSS).
 * That holds under BOTH the current nested model AND the future top-level
 * model. The exact nested URL-STRING assertions (S1/S2 href/text) are
 * clearly labelled NESTED-MODEL so that when the top-level flip lands they
 * red ONLY those labelled lines — a precise "the URL shape changed" signal,
 * not a mystery failure. Update those lines (not the isolation invariant)
 * when PR2 of the top-level sequence deploys.
 *
 * WALKER: the permanent gate-walker shared with e2e/llol4-isolation-gates
 * and e2e/118sb-clickthrough-gate (creds in env / mempalace drawer
 * drawer_eunenem_secrets_afd95964dc3c7bbba928fad8; self-healing bootstrap —
 * the shared DB gets wiped, ids rotate). Its permanent footprint already
 * has exactly the fixture this gate needs: campanha B carries the pretty
 * slug 'gate-camp-b', campanha A is slugless.
 *
 * READ-ONLY: this gate performs NO writes to campanha content (no gifts, no
 * convidados). It only reads share affordances + (idempotently, in
 * beforeAll) ensures B's slug is claimed. Zero pollution on the shared DB.
 *
 * RUN:
 *   E2E_BASE_URL=https://eunenem.xeroxtoxerox.com \
 *   E2E_GATE_EMAIL=<walker email> E2E_GATE_SENHA=<walker senha> \
 *   pnpm exec playwright test e2e/slug-isolation-gate.spec.ts
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';
// Pure seam builders — the SINGLE source of truth for every /pagina and
// convite-preview URL in the app. Asserting the rendered DOM against these
// (rather than hardcoded strings) means this gate tracks the seam: if a
// future refactor changes the URL shape, the seam changes and these
// assertions follow it — while still catching a consumer that stops routing
// through the seam (the exact leak class #367 closed).
import {
  paginaShareDisplayPath,
  paginaSharePath,
  painelConvitePreviewHref,
} from '../apps/eunenem-server/pages/lib/painelRoutes.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

const NOME_EXIBICAO = 'Izzygate Walker';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`; // oldest, slugless
const TITULO_B = 'Segunda Lista do Gate 118sb'; // slug-bearing
const SLUG_CAMP_B = 'gate-camp-b'; // B's fixed pretty campanha-slug

/** campanhas.list card DTO (post-#359): `slug` is the USER's painel slug
 *  (same on every card); `campanhaSlug` is the campanha's OWN chosen slug
 *  (null until definirSlug). The whole operator bug was reading the former
 *  where the latter was meant. */
interface CampanhaCard {
  id: string;
  titulo: string;
  slug: string;
  campanhaSlug: string | null;
}

/** Plain-JSON tRPC helpers — no transformer; envelope {result:{data}};
 *  query input rides ?input= as JSON; mutations POST {data}. */
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

/** First-run wizard walk (post-wipe self-heal) — same recipe as the llol4 +
 *  118sb gates, incl. the observable-state wait (NEVER waitForURL-to-same-
 *  URL: it races page.close() against the in-flight perfil mutation). */
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

// NOT .serial: green-confirmation battery — each gate reports independently
// (serial stops at first failure, hiding the rest). Ordering + shared
// beforeAll state guaranteed by workers=1 in playwright.config.ts.
test.describe('slug / share-link isolation gate (aperture-al8c0 / fblrt #367)', () => {
  test.skip(
    !GATE_EMAIL || !GATE_SENHA,
    'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker creds live in env/mempalace',
  );

  let api: APIRequestContext;
  let context: BrowserContext;
  let userSlug: string; // the walker's USER painel slug (me.slug)
  let campA: CampanhaCard; // oldest, slugless
  let campB: CampanhaCard; // pretty-slug 'gate-camp-b'

  test.beforeAll(async ({ browser, baseURL }) => {
    expect(baseURL, 'baseURL must be configured').toBeTruthy();
    api = await pwRequest.newContext({ baseURL });

    // Idempotent login-or-signup (bypasses the 410 email/senha wall).
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
      const me2 = await trpcQuery<{ needsOnboarding: boolean }>(api, 'auth.me');
      expect(me2.needsOnboarding, 'wizard walk must persist the perfil').toBe(false);
      await page.close();
    }

    // Kill the painel tutorial overlay — it PULSES the menu tiles, making
    // them permanently "not stable" for Playwright actionability. Idempotent.
    await trpcMutation(api, 'usuario.completarTutorial', {});

    // Ensure both campanhas exist (B minted on cold-start).
    let list = await trpcQuery<{ novas: CampanhaCard[] }>(api, 'campanhas.list');
    if (!list.novas.some((c) => c.titulo === TITULO_B)) {
      await trpcMutation(api, 'campanhas.criar', { titulo: TITULO_B });
      list = await trpcQuery<{ novas: CampanhaCard[] }>(api, 'campanhas.list');
    }
    campA = list.novas.find((c) => c.titulo === TITULO_A) as CampanhaCard;
    campB = list.novas.find((c) => c.titulo === TITULO_B) as CampanhaCard;
    expect(campA, `walker must own "${TITULO_A}" (the oldest, slugless campanha)`).toBeTruthy();
    expect(campB, `walker must own "${TITULO_B}" (the slug-bearing campanha)`).toBeTruthy();

    // Claim B's pretty slug (idempotent — definirSlug excludes self; holding
    // the same slug is a no-op). A is deliberately left slugless.
    await trpcMutation(api, 'campanhas.definirSlug', {
      idCampanha: campB.id,
      slug: SLUG_CAMP_B,
    });

    // Re-read so campB.campanhaSlug reflects the claim + confirm A stayed null
    // (the fixture the whole DISPLAY isolation rests on).
    const after = await trpcQuery<{ novas: CampanhaCard[] }>(api, 'campanhas.list');
    campA = after.novas.find((c) => c.id === campA.id) as CampanhaCard;
    campB = after.novas.find((c) => c.id === campB.id) as CampanhaCard;
    expect(campB.campanhaSlug, `B must carry the pretty slug '${SLUG_CAMP_B}'`).toBe(SLUG_CAMP_B);
    expect(campA.campanhaSlug, 'A must remain slugless (NULL-slug fixture)').toBeNull();
    expect(
      campA.slug,
      'both cards share ONE user painel slug (the field the bug read as the campanha slug)',
    ).toBe(campB.slug);
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  /** Open a campanha's painel via its /c/:id route (idCampanha in the URL →
   *  no async default-campanha resolution needed; deterministic). */
  async function gotoPainel(page: Page, camp: CampanhaCard): Promise<void> {
    const res = await page.goto(`/painel/${userSlug}/c/${camp.id}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(res?.status(), `painel /c/${camp.id} must load`).toBe(200);
    // The share chip anchor is the surface under test — wait for it.
    await expect(page.locator('a.painel-url-slug')).toBeVisible();
  }

  // ── S1 — DISPLAY isolation on the SLUG-BEARING campanha (P0a) ────────────
  // The operator's exact bug: B (slug=gate-camp-b) must show ITS OWN address,
  // not the bare user-slug that every campanha collapsed to pre-#367.
  test('S1 — B painel share chip shows the campanha OWN slug (userSlug/gate-camp-b)', async () => {
    const page = await context.newPage();
    try {
      await gotoPainel(page, campB);
      const anchor = page.locator('a.painel-url-slug');

      // Text = paginaShareDisplayPath(userSlug, 'gate-camp-b') = 'user/gate-camp-b'.
      // PRE-#367 this read bare 'user' (the collapse bug) → this line reds it.
      const expectedText = paginaShareDisplayPath(userSlug, campB.campanhaSlug);
      expect(expectedText, 'fixture sanity: B display path is user/campanhaSlug').toBe(
        `${userSlug}/${SLUG_CAMP_B}`,
      );
      await expect(anchor, 'B chip text must carry the campanha slug').toHaveText(expectedText);

      // href = paginaSharePath(userSlug, idB, 'gate-camp-b') = /pagina/user/gate-camp-b
      // [NESTED-MODEL assertion — update when the top-level flip lands].
      const expectedHref = paginaSharePath(userSlug, campB.id, campB.campanhaSlug);
      expect(expectedHref).toBe(`/pagina/${userSlug}/${SLUG_CAMP_B}`);
      await expect(anchor, 'B chip href must be the pretty campanha URL').toHaveAttribute(
        'href',
        new RegExp(`${expectedHref.replace(/[/-]/g, '\\$&')}$`),
      );
    } finally {
      await page.close();
    }
  });

  // ── S2 — DISPLAY on the SLUGLESS campanha degrades to /c/<uuid> (NULL-slug) ─
  test('S2 — A painel (slugless) shows bare user-slug + /c/<uuid> canonical href', async () => {
    const page = await context.newPage();
    try {
      await gotoPainel(page, campA);
      const anchor = page.locator('a.painel-url-slug');

      // Slugless → display is the bare user-slug (uuid stays out of the pill).
      const expectedText = paginaShareDisplayPath(userSlug, campA.campanhaSlug);
      expect(expectedText, 'fixture sanity: A display path is the bare user-slug').toBe(userSlug);
      await expect(anchor, 'A chip must show the bare user-slug (no campanha segment)').toHaveText(
        userSlug,
      );
      // And must NOT leak B's chosen slug.
      await expect(anchor).not.toHaveText(new RegExp(SLUG_CAMP_B));

      // href = /pagina/user/c/<idA> canonical [NESTED-MODEL assertion].
      const expectedHref = paginaSharePath(userSlug, campA.id, campA.campanhaSlug);
      expect(expectedHref).toBe(`/pagina/${userSlug}/c/${campA.id}`);
      await expect(anchor, 'A chip href must be the /c/<uuid> canonical form').toHaveAttribute(
        'href',
        new RegExp(`/pagina/${userSlug}/c/${campA.id}$`),
      );
    } finally {
      await page.close();
    }
  });

  // ── S_CROSS — the MODEL-AGNOSTIC isolation invariant ────────────────────
  // Two distinctly-addressed campanhas render DIFFERENT share addresses.
  // This is THE bug the operator hit (every campanha showed /pagina/francisco)
  // and it survives the incoming top-level redesign unchanged: whatever the
  // URL shape, B's address must never equal a sibling's.
  test('S_CROSS — B and A render DIFFERENT share addresses (no cross-leak)', async () => {
    const pageB = await context.newPage();
    const pageA = await context.newPage();
    try {
      await gotoPainel(pageB, campB);
      await gotoPainel(pageA, campA);
      const textB = await pageB.locator('a.painel-url-slug').textContent();
      const textA = await pageA.locator('a.painel-url-slug').textContent();
      const hrefB = await pageB.locator('a.painel-url-slug').getAttribute('href');
      const hrefA = await pageA.locator('a.painel-url-slug').getAttribute('href');

      expect(textB?.trim(), 'B and A share chips must not display the same address').not.toBe(
        textA?.trim(),
      );
      expect(hrefB, 'B and A share chips must not link to the same public page').not.toBe(hrefA);
      // Belt-and-suspenders: B's address must actually mention its own slug.
      expect(textB, "B's chip must carry B's own slug").toContain(SLUG_CAMP_B);
      expect(textA, "A's chip must NOT carry B's slug").not.toContain(SLUG_CAMP_B);
    } finally {
      await pageB.close();
      await pageA.close();
    }
  });

  // ── S3 — PERFIL share row carries the campanha slug (P0a, second surface) ─
  test('S3 — B perfil share row shows userSlug/gate-camp-b in display + title', async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`/painel/${userSlug}/c/${campB.id}/perfil`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status(), 'B perfil page must load').toBe(200);
      const shareUrl = page.locator('.perfil-share-url');
      await expect(shareUrl).toBeVisible();

      // Display text carries the pretty campanha slug (was bare pre-#367).
      await expect(shareUrl, 'perfil display must carry the campanha slug').toContainText(
        `${userSlug}/${SLUG_CAMP_B}`,
      );
      // The title attr is the full absolute copy URL — must carry the pretty
      // path too (PerfilBody previously copied the /c/ form even with a slug).
      await expect(
        shareUrl,
        'perfil copy URL (title) must be the pretty campanha URL',
      ).toHaveAttribute('title', new RegExp(`/pagina/${userSlug}/${SLUG_CAMP_B}$`));
    } finally {
      await page.close();
    }
  });

  // ── S4 — CONVITE preview href carries the ROUTE campanha's idCampanha (P0b) ─
  // The "ver convite salvo" anchor is built from painelConvitePreviewHref(
  // slug, idCampanha) — the SAME seam the native-share URL uses
  // (buildConvitePreviewShareUrl). Pre-#367 the native share dropped
  // idCampanha → every share opened the OLDEST campanha's preview. Asserting
  // this stable anchor carries /c/<idB> proves the seam threads idCampanha.
  test('S4 — B convite preview link carries /c/<idB> (not oldest-campanha leak)', async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`/painel/${userSlug}/c/${campB.id}/convite`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status(), 'B convite page must load').toBe(200);

      const previewLink = page.locator('a[aria-label="ver convite salvo"]');
      await expect(previewLink, 'convite section must expose the saved-preview link').toBeVisible();

      const expectedHref = painelConvitePreviewHref(userSlug, campB.id);
      expect(expectedHref).toBe(`/painel/${userSlug}/c/${campB.id}/convite/preview`);
      await expect(
        previewLink,
        'convite preview must target THIS campanha, not the oldest (P0b leak)',
      ).toHaveAttribute('href', new RegExp(`${expectedHref.replace(/[/-]/g, '\\$&')}$`));
      // The leak signature: a BARE /painel/<user>/convite/preview (no /c/) is
      // the pre-#367 oldest-campanha target. Assert it is NOT that.
      await expect(previewLink).not.toHaveAttribute(
        'href',
        new RegExp(`/painel/${userSlug}/convite/preview$`),
      );
    } finally {
      await page.close();
    }
  });

  // ── S5 — NAVBAR brand on the PUBLIC page keeps campanha context (P1) ─────
  // Pre-#367 the brand was hardcoded `/pagina/${slug}` (bare → oldest). #367
  // routes it through paginaSharePath(slug, idCampanhaNav) so a guest viewing
  // campanha B stays on B. We open B's canonical public URL (/c/<idB>) so the
  // route provider has idCampanha immediately (no async slug resolution).
  test('S5 — navbar brand on B public page keeps /c/<idB>, never bare /pagina/user', async () => {
    const page = await context.newPage();
    try {
      const res = await page.goto(`/pagina/${userSlug}/c/${campB.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status(), 'B public page must load').toBe(200);

      // The brand is the first anchor in the navbar with the "início" label.
      const brand = page.locator('a[aria-label="EuNeném — início"]');
      await expect(brand).toBeVisible();

      const expectedHref = paginaSharePath(userSlug, campB.id); // /pagina/user/c/<idB>
      expect(expectedHref).toBe(`/pagina/${userSlug}/c/${campB.id}`);
      await expect(brand, 'navbar brand must keep the campanha context').toHaveAttribute(
        'href',
        new RegExp(`/pagina/${userSlug}/c/${campB.id}$`),
      );
      // The leak signature: bare /pagina/<user> (drops to oldest).
      await expect(brand).not.toHaveAttribute('href', new RegExp(`/pagina/${userSlug}$`));
    } finally {
      await page.close();
    }
  });
});
