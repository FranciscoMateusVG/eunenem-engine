/**
 * aperture-llol4 — W1c ISOLATION GATES for the fblrt multicampanha epic.
 *
 * Design doc §7 success metric, made executable: "isolated" only means
 * isolated when a robot writes on campanha B and PROVES A didn't move.
 * These gates block W1a (aperture-aphk8) + W1b (aperture-1yx1n) close.
 *
 * GATE FAMILIES + red-first profile on TODAY's deployed app:
 *   G1a GIFT write isolation      — RED (aperture-dyxhi: the painel gift
 *       add drops idCampanha → the write lands on the DEFAULT campanha).
 *   G1b CONVIDADO write isolation — RED (same client-drop class).
 *   G2  /pagina public isolation  — RED on the B-side (PaginaPage.tsx
 *       `void idCampanha` → /c/<B> renders the OLDEST campanha's gifts);
 *       GREEN back-compat pins (bare + /c/<A> = oldest content) must
 *       stay green forever.
 *   G3  RSVP per campanha         — RED. rvhlt/#356 fixed the convidado
 *       hop (getParaConfirmar convidado-first — DEPLOYED, works), but the
 *       RSVP page's SIBLING convite-preview query (getPreview({slug}))
 *       still drops idCampanha → resolves the oldest campanha's (absent)
 *       evento → NotFound. Green when Vance's phase-B convidado-first
 *       preview + Rex's getParaConfirmar-output idCampanha amendment land.
 *       (Isolated by this gate 2026-07-09 — a leak deeper than rvhlt scope.)
 *
 * DEFERRED (documented, not forgotten):
 *   - G1c convite-save UI gate + recado-mark gate: no testid contract on
 *     ConviteBody / MensagensBody yet — waits for Vance's W1b testid
 *     message (contract-first; see aperture-llol4 notes). The SERVER-side
 *     convite isolation IS pinned here (bootstrap saves B's convite via
 *     tRPC and asserts A's stayed null).
 *   - G2 name/date/mural axes: per-campanha perfil (perfil_campanhas) and
 *     its seeds don't exist until W1a/W1b land — assertions follow the
 *     frozen perfilCampanha.* contract.
 *   - G4 campanha-slug routing (/pagina/<user-slug>/<campanha-slug>,
 *     per-conta uniqueness, reserved words c/sucesso): waits for Rex's
 *     frozen W1a slug contract (procedure names + validation messages).
 *
 * POLLUTION CONTROL (this spec runs RED against a prod-serving DB — the
 * misdirected writes are REAL rows landing on the WRONG campanha):
 *   - every written artifact carries a per-run unique suffix;
 *   - "A unchanged" pins are COUNT-DELTA + name-absence within the run,
 *     never absolute counts (the 118sb gate owns A's absolute catalog);
 *   - gifts are cleaned up in `finally` via contribuicao.delete against
 *     WHEREVER the row actually landed (explicit idCampanha per side);
 *   - convidados have no delete mutation — unique names + delta pins
 *     only; accumulation is bounded to one stray per red run on B's (or
 *     wrongly A's) lista and is walker-scoped.
 *
 * WALKER: same permanent gate-walker as e2e/118sb-clickthrough-gate.spec.ts
 * (creds in env / mempalace drawer_eunenem_secrets_afd95964dc3c7bbba928fad8;
 * self-healing bootstrap — the shared DB gets wiped, ids rotate).
 *
 * RUN:
 *   E2E_BASE_URL=https://eunenem.xeroxtoxerox.com \
 *   E2E_GATE_EMAIL=<walker email> E2E_GATE_SENHA=<walker senha> \
 *   pnpm exec playwright test e2e/llol4-isolation-gates.spec.ts
 */
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';
import { seedGateWalker } from './gate-fixtures.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

const NOME_EXIBICAO = 'Izzygate Walker';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`;
const TITULO_B = 'Segunda Lista do Gate 118sb';
/** A-side catalog anchor shared with the 118sb gate (same walker, same
 *  item — reseeded idempotently here so either spec can cold-start). */
const CONTENT_ITEM_A = 'Presente do Gate 118sb';

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const GIFT_B = `Mimo Gate llol4 ${RUN_SUFFIX}`;
const CONVIDADO_B = `Convidada Gate ${RUN_SUFFIX}`;

/** Per-campanha perfil axis (G5/G6/G7): DISTINCT baby name + event date per
 *  campanha, so the public page proves "outro filho, outra data" isolation.
 *  Deterministic (not suffixed) — B's slug + perfil are permanent walker
 *  state, re-seeded idempotently in beforeAll. */
const SLUG_CAMP_B = 'gate-camp-b'; // B's fixed pretty campanha-slug
const BEBE_A = 'Bebe Um Gate';
const BEBE_B = 'Bebe Dois Gate';
const DATA_A = '2030-01-01'; // dataEvento (date-only; the wizard/API coerce)
const DATA_B = '2031-12-25';

interface CampanhaNova {
  id: string;
  slug: string;
  titulo: string;
}
interface CatalogItem {
  id: string;
  nome: string;
}
interface Convidado {
  id: string;
  nome: string;
  presenca: string;
}
/** Live shape (probed): both eventoListaDeConvidados.get AND
 *  .adicionarConvidado return `{ lista: { convidados } | null }` — the
 *  convidados array is NESTED under `lista`, never top-level, and `lista`
 *  is null for a campanha with no evento. */
interface ListaConvidadosResp {
  lista: { convidados: Convidado[] } | null;
}
/** Defensive extractor — [] when the campanha has no evento/lista. */
function convidadosOf(resp: ListaConvidadosResp): Convidado[] {
  return resp.lista?.convidados ?? [];
}

async function listaConvidados(api: APIRequestContext, idCampanha: string): Promise<Convidado[]> {
  const resp = await trpcQuery<ListaConvidadosResp>(api, 'eventoListaDeConvidados.get', {
    idCampanha,
  }).catch(() => ({ lista: null }) as ListaConvidadosResp);
  return convidadosOf(resp);
}

/** Convidado name comparison is CASE-INSENSITIVE: the server runs
 *  capitalizeGuestName on save (first letter of each word upper, rest
 *  lower), so a suffix starting with a letter is stored title-cased and
 *  an exact-match against the raw suffix misses — silently, and only for
 *  letter-first random suffixes (digit-first pass unchanged). That
 *  suffix-first-char luck is what made this gate flake. Banked 2026-07-09.
 *  The STORED artifact != the constructed model — normalize before compare. */
function hasConvidado(list: Convidado[], nome: string): boolean {
  const target = nome.toLowerCase();
  return list.some((c) => c.nome.toLowerCase() === target);
}

/** Poll B's lista until `nome` appears (read-after-write across a SEPARATE
 *  api context lags the browser's own mutation response). ~5s budget. */
async function waitForConvidado(
  api: APIRequestContext,
  idCampanha: string,
  nome: string,
): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (hasConvidado(await listaConvidados(api, idCampanha), nome)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Plain-JSON tRPC helpers — no transformer registered; envelope is
 *  `{result:{data:<output>}}`; query input rides `?input=` as JSON. */
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

/** Fire a tRPC POST and return the ERROR envelope's {code,message} — for
 *  asserting frozen error contracts + byte-identical non-leaking rejects.
 *  Throws if the call unexpectedly SUCCEEDED (the caller wanted an error). */
async function trpcError(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
  method: 'GET' | 'POST' = 'POST',
): Promise<{ status: number; code?: string; message?: string }> {
  // tRPC queries are GET-only (a POST → METHOD_NOT_SUPPORTED, masking the
  // real error contract); mutations are POST. Caller picks per procedure.
  const res =
    method === 'GET'
      ? await api.get(`/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : await api.post(`/api/trpc/${procedure}`, { data: input });
  const json = (await res.json()) as {
    error?: { message?: string; data?: { code?: string } };
  };
  expect(res.ok(), `${procedure} was expected to ERROR but returned ${res.status()}`).toBe(false);
  return { status: res.status(), code: json.error?.data?.code, message: json.error?.message };
}

/** Seed a campanha's per-campanha perfil (whole-content upsert — every
 *  field ships, omitted = wiped). dataEvento is coerced from a date-only
 *  string at noon to dodge TZ date-shifts. */
async function seedPerfil(
  api: APIRequestContext,
  idCampanha: string,
  nomeBebe: string,
  dataEvento: string,
): Promise<void> {
  await trpcMutation(api, 'perfilCampanha.atualizar', {
    idCampanha,
    nomeBebe,
    relacao: null,
    historia: null,
    dataNascimento: null,
    tipoEvento: 'cha-bebe',
    genero: 'surpresa',
    dataEvento: `${dataEvento}T12:00:00.000Z`,
    fotoPerfilKey: null,
    fotoCapaKey: null,
    fotoHistoriaKey: null,
  });
}

/** Reset a campanha's perfil to incomplete (nomeBebe null) so the
 *  card-completar affordance + setup wizard resurface (G7). */
async function seedPerfilNull(api: APIRequestContext, idCampanha: string): Promise<void> {
  await trpcMutation(api, 'perfilCampanha.atualizar', {
    idCampanha,
    nomeBebe: null,
    relacao: null,
    historia: null,
    dataNascimento: null,
    tipoEvento: null,
    genero: null,
    dataEvento: null,
    fotoPerfilKey: null,
    fotoCapaKey: null,
    fotoHistoriaKey: null,
  });
}

/** Valid eventoConvite.save payload — copied verbatim from the g1wl4 hops
 *  suite (tests/unit/server/g1wl4-router-idcampanha-hops.test.ts). */
function conviteSaveInput(nomeExibido: string, idCampanha?: string) {
  return {
    ...(idCampanha === undefined ? {} : { idCampanha }),
    tipoEvento: 'cha-bebe' as const,
    modalidade: 'presencial' as const,
    dataHoraIso: '2026-08-01T15:00:00.000Z',
    endereco: 'Rua das Flores, 123',
    remetente: 'Francisco',
    nomeExibido,
    mensagem: 'Venha comemorar conosco!',
    paleta: 'lilas' as const,
    fonte: 'patrick' as const,
    modelo: 'scrapbook' as const,
  };
}

/** First-run wizard walk (post-wipe self-heal) — same as the 118sb gate,
 *  including the observable-state wait (never waitForURL-to-same-URL:
 *  banked 2026-07-08, it races page.close() against in-flight mutations). */
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

// NOT .serial: this is a red-first BATTERY — each gate must report its own
// red independently (serial stops at the first failure, hiding the rest).
// Ordering + shared beforeAll state are already guaranteed by workers=1 in
// playwright.config.ts.
test.describe('multicampanha isolation gates (aperture-llol4 / fblrt W1c)', () => {
  test.skip(
    !GATE_EMAIL || !GATE_SENHA,
    'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker creds live in env/mempalace',
  );

  let api: APIRequestContext;
  let context: BrowserContext;
  let slug: string;
  let campanhaA: CampanhaNova; // oldest — signup-minted
  let campanhaB: CampanhaNova;

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
    slug = me.slug;

    context = await browser.newContext({ storageState: await api.storageState() });
    await context.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );

    if (me.needsOnboarding) {
      const page = await context.newPage();
      await completeWizard(page, slug);
      const me2 = await trpcQuery<{ needsOnboarding: boolean }>(api, 'auth.me');
      expect(me2.needsOnboarding, 'wizard walk must persist the perfil').toBe(false);
      await page.close();
    }

    // Kill the painel tutorial overlay for good — it PULSES the menu
    // tiles for a fresh user, making them permanently "not stable" for
    // Playwright's actionability check (found on the first red run:
    // tile click timed out with 'element is not stable'). Idempotent.
    await trpcMutation(api, 'usuario.completarTutorial', {});

    let list = await trpcQuery<{ novas: CampanhaNova[] }>(api, 'campanhas.list');
    if (!list.novas.some((c) => c.titulo === TITULO_B)) {
      await trpcMutation(api, 'campanhas.criar', { titulo: TITULO_B });
      list = await trpcQuery<{ novas: CampanhaNova[] }>(api, 'campanhas.list');
    }
    campanhaA = list.novas.find((c) => c.titulo === TITULO_A) as CampanhaNova;
    campanhaB = list.novas.find((c) => c.titulo === TITULO_B) as CampanhaNova;
    expect(campanhaA, `walker must own "${TITULO_A}"`).toBeTruthy();
    expect(campanhaB, `walker must own "${TITULO_B}"`).toBeTruthy();

    // A-side catalog anchor for G2 (idempotent, shared with 118sb gate).
    const catalogA = await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', {
      idCampanha: campanhaA.id,
    });
    if (!catalogA.some((i) => i.nome === CONTENT_ITEM_A)) {
      await trpcMutation(api, 'contribuicao.create', {
        idCampanha: campanhaA.id,
        nome: CONTENT_ITEM_A,
        valor: 11_800,
        quantidade: 1,
      });
    }

    // B needs a convite for convidado writes (adicionarConvidado throws
    // EventoAusente otherwise). Server-side isolation pin rides along:
    // saving B's convite must NOT create/alter A's.
    // SHAPE (probed live): the getter NEVER returns null — a campanha
    // without an evento yields `{evento: null, convite: null}`. Check the
    // INNER field (a bare null-check silently skipped this save and
    // starved G1b/G3 of their evento on the first two runs — banked).
    type ConviteGet = { evento: unknown; convite: unknown };
    const conviteBBefore = await trpcQuery<ConviteGet>(api, 'eventoConvite.get', {
      idCampanha: campanhaB.id,
    });
    const conviteABefore = await trpcQuery<ConviteGet>(api, 'eventoConvite.get', {
      idCampanha: campanhaA.id,
    });
    if (conviteBBefore.evento == null) {
      await trpcMutation(api, 'eventoConvite.save', conviteSaveInput('Bebe Gate B', campanhaB.id));
      const conviteAAfter = await trpcQuery<unknown>(api, 'eventoConvite.get', {
        idCampanha: campanhaA.id,
      });
      expect(
        JSON.stringify(conviteAAfter),
        "SERVER-side convite isolation pin: saving B's convite must leave A's untouched",
      ).toBe(JSON.stringify(conviteABefore));
    }

    // Per-campanha perfil axis (G5/G6): seed DISTINCT baby name + date per
    // campanha so the public page proves isolation. Backfill (migration 035)
    // copied the owner's single perfil onto BOTH campanhas, so absent this
    // seed both read the same name — the seed IS the distinction. Idempotent
    // whole-content upsert (perfilCampanha.atualizar ships every field).
    await seedPerfil(api, campanhaA.id, BEBE_A, DATA_A);
    await seedPerfil(api, campanhaB.id, BEBE_B, DATA_B);
    // B's fixed pretty-slug (idempotent; definirSlug excludes self).
    await trpcMutation(api, 'campanhas.definirSlug', {
      idCampanha: campanhaB.id,
      slug: SLUG_CAMP_B,
    });
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  async function gotoPainelB(page: Page): Promise<void> {
    const res = await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    await page
      .getByTestId('card-campanha')
      .filter({ hasText: TITULO_B })
      .locator('a.camp-cta')
      .click();
    await page.waitForURL(new RegExp(`/painel/${campanhaB.slug}/c/${campanhaB.id}$`));
    // Identity chip sanity — we ARE on B's painel (snfin contract).
    await expect(page.getByTestId('painel-campanha-titulo')).toHaveText(TITULO_B);
  }

  test('G1a — gift added on campanha B painel lands in B and ONLY B', async () => {
    const before = {
      a: await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campanhaA.id }),
      b: await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campanhaB.id }),
    };
    const page = await context.newPage();
    try {
      await gotoPainelB(page);
      // Into B's lista section. Pin the tile's PER-CAMPANHA href first
      // (the #353 section-href threading is itself gate-worthy), then
      // navigate — tiles can animate, so goto beats fighting stability.
      const listaHref = `/painel/${campanhaB.slug}/c/${campanhaB.id}/lista`;
      await expect(
        page.locator('.painel-row', { hasText: 'minha lista de presentes' }),
        'lista tile must carry the campanha-addressed section href',
      ).toHaveAttribute('href', listaHref);
      await page.goto(listaHref, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Criar item personalizado' }).click();
      // Current ListaPresentesBody form ids (the older painel-adicionar-qty
      // spec's 'Nome do mimo' label has since become 'nome do presente').
      await page.locator('#lista-title').fill(GIFT_B);
      await page.locator('#lista-price').fill('50,00');
      // Wait on the MUTATION response, not the UI (pre-fix the item lands
      // on A, so B's list never shows it and a UI wait would fail with an
      // undiagnostic timeout BEFORE the API pins below name the leak).
      // httpBatchLink may comma-join procedures — match by substring.
      const created = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('contribuicao.create'),
        { timeout: 15_000 },
      );
      await page.getByRole('button', { name: 'Adicionar à lista' }).click();
      await created;

      const after = {
        a: await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campanhaA.id }),
        b: await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campanhaB.id }),
      };
      expect(
        after.b.some((i) => i.nome === GIFT_B),
        `the gift added on B's painel must exist in B's catalog — ABSENT means the client ` +
          `dropped idCampanha and the write landed on the DEFAULT campanha (aperture-dyxhi)`,
      ).toBe(true);
      expect(
        after.a.some((i) => i.nome === GIFT_B),
        "campanha A must NOT gain B's gift (cross-campanha write leak)",
      ).toBe(false);
      expect(after.a.length, 'campanha A catalog count must be unchanged').toBe(before.a.length);
      // UI confirmation — reachable only post-fix (B's own list shows it).
      await expect(page.getByText(GIFT_B).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      // Cleanup wherever the row actually landed (red runs land it on A).
      for (const side of [campanhaA.id, campanhaB.id]) {
        const rows = await trpcQuery<CatalogItem[]>(api, 'contribuicao.list', {
          idCampanha: side,
        });
        const stray = rows.filter((i) => i.nome === GIFT_B).map((i) => i.id);
        if (stray.length > 0) {
          await trpcMutation(api, 'contribuicao.delete', { idCampanha: side, ids: stray });
        }
      }
      await page.close();
    }
  });

  test('G1b — convidado added on campanha B painel lands in B and ONLY B', async () => {
    const before = {
      a: await listaConvidados(api, campanhaA.id),
      b: await listaConvidados(api, campanhaB.id),
    };
    const page = await context.newPage();
    await gotoPainelB(page);
    // Same href-pin + goto pattern as G1a (tiles animate; the href
    // threading is the assertable part of the click).
    const convidadosHref = `/painel/${campanhaB.slug}/c/${campanhaB.id}/convidados`;
    await expect(
      page.locator('.painel-row', { hasText: 'lista de convidados' }),
      'convidados tile must carry the campanha-addressed section href',
    ).toHaveAttribute('href', convidadosHref);
    await page.goto(convidadosHref, { waitUntil: 'domcontentloaded' });
    // Open the add dialog (the section trigger), then work strictly INSIDE
    // it — `/^adicionar/i` alone matched both the trigger and the submit,
    // and `.last()` raced actionability on the wrong node.
    await page.getByRole('button', { name: /adicionar convidado/i }).click();
    const dialog = page.getByRole('dialog', { name: 'adicionar convidado' });
    await expect(dialog).toBeVisible();
    await dialog.locator('#convidado-name').fill(CONVIDADO_B);
    await dialog.locator('#convidado-phone').fill('31999990000');
    // Submit — exact text, dialog-scoped (same label as the gift form).
    // Wait on the MUTATION response, not the UI — pre-fix the write lands
    // on A and B's lista never shows it (see G1a note).
    const submit = dialog.getByRole('button', { name: 'Adicionar à lista' });
    await expect(submit, 'submit enables once name + phone validate').toBeEnabled();
    const added = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('adicionarConvidado'),
      { timeout: 15_000 },
    );
    await submit.click();
    await added;
    // UI success is observable (toast); the SERVER read across a separate
    // api context lags the browser mutation — poll rather than single-read.
    const landedInB = await waitForConvidado(api, campanhaB.id, CONVIDADO_B);
    const after = {
      a: await listaConvidados(api, campanhaA.id),
      b: await listaConvidados(api, campanhaB.id),
    };
    expect(
      landedInB,
      `the convidado added on B's painel must exist in B's lista — ABSENT means the client ` +
        `dropped idCampanha (cross-campanha write leak, same class as dyxhi)`,
    ).toBe(true);
    expect(hasConvidado(after.a, CONVIDADO_B), "campanha A must NOT gain B's convidado").toBe(
      false,
    );
    expect(after.a.length, "A's convidado count must be unchanged").toBe(before.a.length);
    // UI confirmation — reachable only post-fix (B's lista shows them).
    await expect(page.getByText(CONVIDADO_B).first()).toBeVisible({ timeout: 10_000 });
    await page.close();
    // No delete mutation exists for convidados — unique per-run names keep
    // pollution identifiable; counts above are within-run deltas only.
  });

  test('G2 — public /pagina isolation: /c/<B> shows B content, /c/<A> + bare show A (oldest)', async ({
    browser,
  }) => {
    // Anonymous visitor — the public page has no session.
    const anon = await browser.newContext();
    const page = await anon.newPage();
    try {
      // Back-compat pins (must be GREEN today and stay green forever):
      const bare = await page.goto(`/pagina/${slug}`, { waitUntil: 'domcontentloaded' });
      expect(bare?.status(), 'bare /pagina/:slug must resolve 200').toBe(200);
      await expect(
        page.getByText(CONTENT_ITEM_A).first(),
        "bare /pagina must show the OLDEST campanha's gift (back-compat)",
      ).toBeVisible({ timeout: 15_000 });

      const viewA = await page.goto(`/pagina/${slug}/c/${campanhaA.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(viewA?.status(), '/pagina/:slug/c/<A> must resolve 200').toBe(200);
      await expect(page.getByText(CONTENT_ITEM_A).first(), "/c/<A> must show A's gift").toBeVisible(
        { timeout: 15_000 },
      );

      // THE isolation assertion (RED today — PaginaPage voids idCampanha
      // and renders the oldest campanha's gifts on every /c/ address):
      const viewB = await page.goto(`/pagina/${slug}/c/${campanhaB.id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(viewB?.status(), '/pagina/:slug/c/<B> must resolve 200').toBe(200);
      // Give the page the same settle window the A-side got, then assert
      // A's gift is ABSENT from B's public page.
      await page.waitForTimeout(3_000);
      await expect(
        page.getByText(CONTENT_ITEM_A),
        "/c/<B> must show campanha B's OWN (empty) gift list — seeing A's gift means " +
          'PaginaPage ignores the route idCampanha (fblrt G2 leak)',
      ).toHaveCount(0);
    } finally {
      await page.close();
      await anon.close();
    }
  });

  test('G3a — BACKEND half: getParaConfirmar output carries the convidado’s OWN campanha id', async () => {
    // Split-assert (Vance suggestion, Rex amendment #3 / commit 7cb9ab1 on
    // the #356 branch): the getParaConfirmar OUTPUT gains an additive
    // idCampanha resolved convidado-first. This backend half deploys with
    // rvhlt, BEFORE Vance's Phase B frontend — so it's the earlier green
    // signal. RED until 7cb9ab1 deploys (probed: output currently lacks
    // the field). GREEN = the public resolver identifies B, not the oldest.
    const nome = `Rsvp Backend ${RUN_SUFFIX}`;
    const lista = await trpcMutation<ListaConvidadosResp>(
      api,
      'eventoListaDeConvidados.adicionarConvidado',
      { idCampanha: campanhaB.id, nome, numeroCelular: '31977776666' },
    );
    const cid = convidadosOf(lista).find((c) => c.nome === nome)?.id as string;
    expect(cid, 'bootstrap convidado must exist on B').toBeTruthy();

    const out = await trpcQuery<{ nome: string; idCampanha?: string }>(
      api,
      'eventoListaDeConvidados.getParaConfirmar',
      { slug, idConvidado: cid },
    );
    expect(out.nome, 'getParaConfirmar must resolve B’s convidado by id').toBe(nome);
    expect(
      out.idCampanha,
      'getParaConfirmar output must carry the convidado’s OWN campanha id (B), not resolve ' +
        'oldest — RED until Rex amendment #3 (commit 7cb9ab1) deploys with rvhlt',
    ).toBe(campanhaB.id);
  });

  test('G3b — guest RSVP for campanha B convidado confirms on B (and only B)', async ({
    browser,
  }) => {
    // Bootstrap: a convidado on B via tRPC WITH explicit idCampanha (the
    // server honors it — this isolates the gate to the PUBLIC resolution
    // path, which is what rvhlt fixes).
    const nomeRsvp = `Rsvp Gate ${RUN_SUFFIX}`;
    const listaB = await trpcMutation<ListaConvidadosResp>(
      api,
      'eventoListaDeConvidados.adicionarConvidado',
      { idCampanha: campanhaB.id, nome: nomeRsvp, numeroCelular: '31988887777' },
    );
    const convidado = convidadosOf(listaB).find((c) => c.nome === nomeRsvp);
    expect(convidado, 'bootstrap convidado must exist on B').toBeTruthy();
    const presencaBefore = (convidado as Convidado).presenca;

    const anon = await browser.newContext();
    const page = await anon.newPage();
    try {
      const res = await page.goto(`/${slug}/confirmar-presenca/${(convidado as Convidado).id}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status(), 'RSVP link must resolve 200').toBe(200);
      // RED cause (isolated 2026-07-09, deeper than the original rvhlt
      // scope): rvhlt/#356 fixed getParaConfirmar (convidado-first) — that
      // half WORKS (probed: getParaConfirmar returns B's convidado). But
      // ConfirmarPresencaPage ALSO calls useConvitePreviewData(slug) →
      // getPreview({slug}) which STILL drops idCampanha → resolves the
      // OLDEST campanha (A). A has no evento → `!conviteQuery.data?.evento`
      // → the page renders NotFound. So B's guest sees "página não
      // encontrada" even though their convidado resolves. GREEN when BOTH
      // land: Vance's phase-B (convidado-first preview resolution) + Rex's
      // getParaConfirmar-output idCampanha amendment (#3). Not a missed
      // write hook — a public READ sibling on the RSVP page.
      await expect(
        page.getByText(`Olá, ${nomeRsvp}!`),
        `guest must see their RSVP greeting — absence means the convite-preview ` +
          `sibling query (getPreview) still resolved the OLDEST campanha's ` +
          `(absent) evento → NotFound, even though rvhlt fixed the convidado hop`,
      ).toBeVisible({ timeout: 15_000 });

      // Confirm attendance through the real UI. exact:true — 'irei' is a
      // SUBSTRING of 'não irei', so a loose name matches both RSVP buttons.
      await page.getByRole('button', { name: 'irei', exact: true }).click();
      await expect(page.getByText('Salvo com sucesso.')).toBeVisible({ timeout: 10_000 });

      // DB-truth pins: B's lista carries the confirmation; A untouched.
      const afterB = await listaConvidados(api, campanhaB.id);
      const confirmed = afterB.find((c) => c.nome === nomeRsvp);
      expect(confirmed, 'the convidado must still live on B').toBeTruthy();
      expect(
        (confirmed as Convidado).presenca,
        "the RSVP must have changed B's convidado presenca",
      ).not.toBe(presencaBefore);
      const afterA = await listaConvidados(api, campanhaA.id);
      expect(
        afterA.some((c) => c.nome === nomeRsvp),
        "A's lista must not contain B's convidado after the RSVP",
      ).toBe(false);
    } finally {
      await page.close();
      await anon.close();
    }
  });

  // ── G4: per-campanha SLUG contract (Rex W1a / aphk8, PR #359) ───────────
  // API-level gates — the /pagina/<user-slug>/<campanha-slug> FRONTEND route
  // is still "future" (App.tsx: UUID /c/<idCampanha> is the live path), so
  // these pin the BACKEND contract that a future public route will lean on.
  // ALL RED today (procedures 404 on deployed until #359 lands); each flips
  // green independently. Frozen contract (Rex msg 1783561363995 + source):
  //   definirSlug({idCampanha,slug}) → {slug}; throws BAD_REQUEST message ∈
  //     {slug_formato_invalido, slug_reservado, slug_em_uso} (long form).
  //   validarSlug({idCampanha,slug}) → {disponivel, motivo ∈
  //     {formato,reservado,em_uso}|null}; NEVER throws for taken/invalid.
  //   resolverCampanhaSlug({slug,campanhaSlug}) → {idCampanha}; unknown
  //     user-slug / no-match / other-conta all collapse to byte-identical
  //     NOT_FOUND (non-leaking).
  // Deterministic slug so re-runs are idempotent (definirSlug excludes self).
  // Fixed (not suffixed) so B's slug is stable across runs — the pretty-slug
  // gate (G5) navigates /pagina/<user>/gate-camp-b, and definirSlug excludes
  // self so re-claiming the same slug on B is idempotent (Rex-confirmed).
  const SLUG_B = SLUG_CAMP_B;

  test('G4a — validarSlug never throws: reserved + bad-format + available verdicts', async () => {
    // 'sucesso' is a documented reserved campanha slug (c/sucesso).
    const reserved = await trpcQuery<{ disponivel: boolean; motivo: string | null }>(
      api,
      'campanhas.validarSlug',
      { idCampanha: campanhaB.id, slug: 'sucesso' },
    );
    expect(reserved, 'validarSlug must NOT throw for a reserved slug — returns a verdict').toEqual({
      disponivel: false,
      motivo: 'reservado',
    });
    // 'AB' fails the min-3 + lowercase-start regex → motivo 'formato'.
    const bad = await trpcQuery<{ disponivel: boolean; motivo: string | null }>(
      api,
      'campanhas.validarSlug',
      {
        idCampanha: campanhaB.id,
        slug: 'AB',
      },
    );
    expect(bad).toEqual({ disponivel: false, motivo: 'formato' });
    // A fresh valid slug is available (motivo null exactly when disponivel).
    const ok = await trpcQuery<{ disponivel: boolean; motivo: string | null }>(
      api,
      'campanhas.validarSlug',
      {
        idCampanha: campanhaB.id,
        slug: `fresh-${RUN_SUFFIX}`,
      },
    );
    expect(ok).toEqual({ disponivel: true, motivo: null });
  });

  test('G4b — definirSlug claims B’s slug; resolverCampanhaSlug round-trips; per-conta uniqueness', async () => {
    // Claim a deterministic slug on B (idempotent: excludes self).
    const claimed = await trpcMutation<{ slug: string }>(api, 'campanhas.definirSlug', {
      idCampanha: campanhaB.id,
      slug: SLUG_B,
    });
    expect(claimed.slug, 'definirSlug returns the normalized persisted slug').toBe(SLUG_B);

    // Public resolver maps (user-slug, campanha-slug) → B's id.
    const resolved = await trpcQuery<{ idCampanha: string }>(api, 'pagina.resolverCampanhaSlug', {
      slug,
      campanhaSlug: SLUG_B,
    });
    expect(resolved.idCampanha, 'campanha-slug must resolve to B, not oldest').toBe(campanhaB.id);

    // Per-conta uniqueness: the SAME slug on campanha A reads em_uso.
    const onA = await trpcQuery<{ disponivel: boolean; motivo: string | null }>(
      api,
      'campanhas.validarSlug',
      { idCampanha: campanhaA.id, slug: SLUG_B },
    );
    expect(onA, "B's slug must be em_uso for a sibling campanha (per-conta unique)").toEqual({
      disponivel: false,
      motivo: 'em_uso',
    });

    // definirSlug throws the FROZEN long-form string for a reserved slug.
    const reservedErr = await trpcError(api, 'campanhas.definirSlug', {
      idCampanha: campanhaB.id,
      slug: 'sucesso',
    });
    expect(reservedErr.code, 'reserved slug → BAD_REQUEST').toBe('BAD_REQUEST');
    expect(reservedErr.message, 'frozen error string (frontend switches on it)').toBe(
      'slug_reservado',
    );
  });

  test('G4c — resolverCampanhaSlug is non-leaking: unknown user-slug ≡ unknown campanha-slug', async () => {
    // Unknown user-slug (valid format, no such user).
    const unknownUser = await trpcError(
      api,
      'pagina.resolverCampanhaSlug',
      { slug: `nouser-${RUN_SUFFIX}`, campanhaSlug: SLUG_B },
      'GET',
    );
    // Known user-slug, unknown campanha-slug.
    const unknownCampanha = await trpcError(
      api,
      'pagina.resolverCampanhaSlug',
      { slug, campanhaSlug: `nocampanha-${RUN_SUFFIX}` },
      'GET',
    );
    expect(unknownUser.code, 'unknown user-slug → NOT_FOUND').toBe('NOT_FOUND');
    // The non-leaking contract: an attacker cannot distinguish "no such user"
    // from "no such campanha" — identical code AND message.
    expect(
      { code: unknownUser.code, message: unknownUser.message },
      'unknown-user and unknown-campanha rejects must be byte-identical (no existence oracle)',
    ).toEqual({ code: unknownCampanha.code, message: unknownCampanha.message });
  });

  // ── G5/G6: per-campanha perfil on the PUBLIC page (fblrt W1b Phase B) ────
  // The operator's literal "outro filho, outra data": two campanhas, two
  // babies, two public pages. Perfis seeded distinct in beforeAll.

  test('G5 — pretty-slug BROWSER route: /pagina/<user>/<campanha-slug> loads B in a real browser', async ({
    browser,
  }) => {
    const anon = await browser.newContext();
    const page = await anon.newPage();
    try {
      // The two-segment pretty URL resolves via pagina.resolverCampanhaSlug
      // → B's id → B's perfil. (Backend resolver is G4b; THIS is the browser
      // route + render, which only shipped with Vance's W1b Phase B.)
      const res = await page.goto(`/pagina/${slug}/${SLUG_CAMP_B}`, {
        waitUntil: 'domcontentloaded',
      });
      expect(res?.status(), 'pretty-slug page must resolve 200').toBe(200);
      await expect(
        page.getByTestId('pagina-baby-name'),
        `/pagina/${slug}/${SLUG_CAMP_B} must render campanha B's baby name — the pretty ` +
          'slug resolved the wrong campanha (or oldest) if this shows anything else',
      ).toHaveText(BEBE_B, { timeout: 15_000 });
      // An unknown campanha-slug renders the not-found body (200 SSR).
      const bad = await page.goto(`/pagina/${slug}/no-such-camp`, {
        waitUntil: 'domcontentloaded',
      });
      expect(bad?.status(), 'unknown campanha-slug → 200 SSR (not-found body)').toBe(200);
      await expect(page.getByTestId('pagina-baby-name')).toHaveCount(0);
    } finally {
      await page.close();
      await anon.close();
    }
  });

  test('G6 — public page perfil isolation: /c/<B> shows B’s baby+date, /c/<A> + bare show A', async ({
    browser,
  }) => {
    const anon = await browser.newContext();
    const page = await anon.newPage();
    try {
      const babyOn = async (path: string): Promise<string> => {
        const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
        expect(res?.status(), `${path} must resolve 200`).toBe(200);
        return (await page.getByTestId('pagina-baby-name').textContent({ timeout: 15_000 })) ?? '';
      };
      const dateOn = async (): Promise<string> =>
        (await page
          .getByTestId('pagina-event-date')
          .textContent()
          .catch(() => '')) ?? '';

      // Campanha B's page → B's baby + date.
      expect((await babyOn(`/pagina/${slug}/c/${campanhaB.id}`)).trim()).toBe(BEBE_B);
      const dateB = await dateOn();
      // Campanha A's page → A's baby (distinct).
      expect((await babyOn(`/pagina/${slug}/c/${campanhaA.id}`)).trim()).toBe(BEBE_A);
      const dateA = await dateOn();
      // Bare URL → oldest (A).
      expect((await babyOn(`/pagina/${slug}`)).trim()).toBe(BEBE_A);

      // The core isolation: the two babies differ, AND the two event-date
      // countdowns differ (distinct dataEvento → distinct countdown text).
      expect(BEBE_A, 'the two campanhas must show DIFFERENT babies').not.toBe(BEBE_B);
      expect(
        dateA && dateB ? dateA !== dateB : true,
        'distinct event dates must yield distinct countdowns on each page',
      ).toBe(true);
    } finally {
      await page.close();
      await anon.close();
    }
  });

  test('G7 — SetupCampanhaWizard writes B’s per-campanha perfil (the operator create-flow)', async () => {
    // Exercise the WIZARD UI (not just the API seed): reset B to incomplete
    // so card-completar surfaces, walk the wizard, assert it persists B's
    // perfil. Runs LAST + re-establishes BEBE_B so G5/G6 (earlier in file
    // order, workers=1) keep their seeded value. Idempotent across runs.
    await seedPerfilNull(api, campanhaB.id);
    const listBefore = await trpcQuery<{ novas: Array<{ id: string; nomeBebe: string | null }> }>(
      api,
      'campanhas.list',
    );
    expect(
      listBefore.novas.find((c) => c.id === campanhaB.id)?.nomeBebe,
      'after reset, B must read incomplete (nomeBebe null) so card-completar shows',
    ).toBeNull();

    const page = await context.newPage();
    try {
      const res = await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      expect(res?.status()).toBe(200);
      const cardB = page.getByTestId('card-campanha').filter({ hasText: TITULO_B });
      await cardB.getByTestId('card-completar').click();

      const wizard = page.getByTestId('setup-wizard-modal');
      await expect(wizard).toBeVisible();
      await wizard.getByTestId('setup-wizard-nome-bebe').fill(BEBE_B);
      await wizard.getByTestId('setup-wizard-data').fill(DATA_B);
      await wizard.getByTestId('setup-wizard-tipo').selectOption('cha-bebe');
      await wizard.getByTestId('setup-wizard-genero-menino').click();
      // Slug pre-fills from titulo; B already owns SLUG_CAMP_B, and definirSlug
      // excludes self, so leaving/keeping it is a valid idempotent submit.
      const submitted = page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().includes('perfilCampanha.atualizar'),
        { timeout: 15_000 },
      );
      await wizard.getByTestId('setup-wizard-submit').click();
      await submitted;

      // DB-truth: the wizard persisted B's perfil (nomeBebe flipped non-null
      // to the wizard value). Poll — the list DTO read lags the mutation.
      let landed = '';
      for (let i = 0; i < 10; i++) {
        const l = await trpcQuery<{ novas: Array<{ id: string; nomeBebe: string | null }> }>(
          api,
          'campanhas.list',
        );
        landed = l.novas.find((c) => c.id === campanhaB.id)?.nomeBebe ?? '';
        if (landed === BEBE_B) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(
        landed,
        'the wizard submit must persist B’s baby name via perfilCampanha.atualizar',
      ).toBe(BEBE_B);
    } finally {
      await page.close();
    }
  });
});
