/**
 * aperture-u38rz item 3 — NOVA LISTA create flow E2E (frontend: PR #331,
 * aperture-rurre; backend: campanhas.criar, aperture-x0unf).
 *
 * Walks the real create flow that replaced the POC stub toast (the old stub
 * test lives in e2e/8jcec-campanhas-multicampanha.spec.ts and is superseded
 * by this spec for the create path):
 *   1. HAPPY — card-nova-lista → name modal → titulo → submit → modal closes,
 *      a NEW card-campanha carrying the titulo appears, card count +1, and we
 *      STAY on /campanhas (V1 has no per-campanha routing).
 *   2. VALIDATION — empty titulo: submit is DISABLED (per CampanhasPage.tsx,
 *      `disabled={!novoTitulo.trim() || criarM.isPending}`), and submitNova
 *      early-returns on the Enter-key path — so no mutation fires, modal
 *      stays open, no crash, no new card.
 *   3. ERROR — campanhas.criar fulfilled with a 500 → onError keeps the modal
 *      open (typed name preserved) + sonner error toast; grid intact, no card.
 *   4. CANCEL — open → cancelar → modal closes, zero campanhas.criar fired,
 *      no new card.
 *
 * DB POSTURE (Phase 1, established): each happy-path run creates a REAL
 * campanha for the shared legacy user in the local dev DB — the fixture has
 * no cleanup. Titulos carry a random suffix and assertions are COUNT-DELTA
 * (before/after), never absolute.
 *
 * GOTCHA (banked 2026-07-07): the welcome modal mounts after campanhas.list
 * resolves and intercepts clicks — every test pre-seeds the dismissed flag
 * via addInitScript BEFORE goto.
 *
 * tRPC MATCHING: httpBatchLink may comma-join batched procedures in the path
 * (/api/trpc/a,b?batch=1 — see e2e/painel-editar-mimo.spec.ts). Both the
 * route interceptor and the request listeners therefore match the procedure
 * as a path SUBSTRING, not an exact URL.
 */
import type { Page } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { expect, test } from './legacy-fixtures.js';

const CRIAR_PROCEDURE = 'campanhas.criar';

function randomTitulo(): string {
  return `Lista E2E u38rz ${Math.random().toString(36).slice(2, 8)}`;
}

/** Pre-seed the welcome-modal dismissed flag (see header gotcha) and land
 *  on /campanhas with the grid hydrated (nova-lista card = past loading). */
async function gotoCampanhas(page: Page): Promise<void> {
  await page.addInitScript(
    ([key]) => window.localStorage.setItem(key, '1'),
    [CAMPANHAS_WELCOME_STORAGE_KEY],
  );
  const res = await page.goto('/campanhas', { waitUntil: 'domcontentloaded' });
  expect(res, 'goto must return a Response').toBeTruthy();
  expect(res?.status(), '/campanhas must resolve 200 for an authed user').toBe(200);
  await expect(page.getByTestId('campanhas-grid')).toBeVisible();
  await expect(page.getByTestId('card-nova-lista')).toBeVisible();
}

/** Collect every campanhas.criar POST that fires (httpBatchLink-aware). */
function trackCriarCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const m = req.url().match(/\/api\/trpc\/([^?]+)/);
    if (!m?.[1]) return;
    for (const procedure of m[1].split(',')) {
      if (procedure === CRIAR_PROCEDURE) calls.push(procedure);
    }
  });
  return calls;
}

test.describe('/campanhas — NOVA LISTA create flow (aperture-u38rz item 3)', () => {
  test('happy path: create modal → titulo → submit → new card in grid, still on /campanhas', async ({
    legacyPage: page,
  }) => {
    await gotoCampanhas(page);

    const grid = page.getByTestId('campanhas-grid');
    const cards = grid.getByTestId('card-campanha');
    const before = await cards.count();

    await page.getByTestId('card-nova-lista').click();
    const modal = page.getByTestId('nova-lista-modal');
    await expect(modal).toBeVisible();

    const titulo = randomTitulo();
    await page.getByTestId('nova-lista-input').fill(titulo);
    await page.getByTestId('nova-lista-submit').click();

    // Success path: modal closes, list invalidates, the new 2.0 card lands.
    await expect(modal).toBeHidden();
    await expect(grid.getByTestId('card-campanha').filter({ hasText: titulo })).toBeVisible();
    await expect(cards).toHaveCount(before + 1);

    // V1 stays on /campanhas — no per-campanha routing after create.
    await expect(page).toHaveURL(/\/campanhas$/);
  });

  test('validation: empty titulo — submit disabled, Enter fires no mutation, modal stays open', async ({
    legacyPage: page,
  }) => {
    const criarCalls = trackCriarCalls(page);
    await gotoCampanhas(page);

    const cards = page.getByTestId('campanhas-grid').getByTestId('card-campanha');
    const before = await cards.count();

    await page.getByTestId('card-nova-lista').click();
    const modal = page.getByTestId('nova-lista-modal');
    await expect(modal).toBeVisible();

    // The implementation's empty-titulo contract: the submit button is
    // DISABLED (no inline error copy exists). Whitespace-only counts as
    // empty — titulo is trimmed before the guard.
    const submit = page.getByTestId('nova-lista-submit');
    await expect(submit).toBeDisabled();
    await page.getByTestId('nova-lista-input').fill('   ');
    await expect(submit).toBeDisabled();

    // Belt and braces: the Enter-key form submit path early-returns in
    // submitNova. Dispatch it and give any would-be request time to fire.
    await page.getByTestId('nova-lista-input').press('Enter');
    await page.waitForTimeout(300);

    expect(criarCalls, 'no campanhas.criar may fire for an empty titulo').toHaveLength(0);
    await expect(modal, 'modal must stay open — no crash, no dismiss').toBeVisible();
    await expect(cards).toHaveCount(before);
  });

  test('server error: campanhas.criar 500 → friendly toast, modal stays open, no new card, no crash', async ({
    legacyPage: page,
  }) => {
    // Intercept the mutation. httpBatchLink can comma-join procedures, so a
    // fixed glob like **/api/trpc/campanhas.criar* would miss a batched
    // /api/trpc/other,campanhas.criar — match by URL predicate instead.
    await page.route(
      (url) => url.pathname.startsWith('/api/trpc/') && url.pathname.includes(CRIAR_PROCEDURE),
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              error: {
                json: {
                  message: 'e2e-forced failure',
                  code: -32603,
                  data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
                },
              },
            },
          ]),
        });
      },
    );

    await gotoCampanhas(page);

    const grid = page.getByTestId('campanhas-grid');
    const cards = grid.getByTestId('card-campanha');
    const before = await cards.count();

    await page.getByTestId('card-nova-lista').click();
    const modal = page.getByTestId('nova-lista-modal');
    await expect(modal).toBeVisible();

    const titulo = randomTitulo();
    await page.getByTestId('nova-lista-input').fill(titulo);
    await page.getByTestId('nova-lista-submit').click();

    // onError contract: friendly sonner toast + modal stays open so the
    // typed name isn't lost (saga-compensated backend — nothing half-made).
    await expect(page.locator('[data-sonner-toast]')).toContainText(
      'não conseguimos criar sua lista agora',
    );
    await expect(modal, 'modal must stay open on error').toBeVisible();
    await expect(page.getByTestId('nova-lista-input')).toHaveValue(titulo);

    // No crash: dismiss the modal and the grid is intact, count unchanged.
    await page.getByTestId('nova-lista-cancel').click();
    await expect(modal).toBeHidden();
    await expect(grid).toBeVisible();
    await expect(cards).toHaveCount(before);
    await expect(grid.getByTestId('card-campanha').filter({ hasText: titulo })).toHaveCount(0);
  });

  test('cancel: close the modal without submitting — zero mutations, no new card', async ({
    legacyPage: page,
  }) => {
    const criarCalls = trackCriarCalls(page);
    await gotoCampanhas(page);

    const cards = page.getByTestId('campanhas-grid').getByTestId('card-campanha');
    const before = await cards.count();

    await page.getByTestId('card-nova-lista').click();
    const modal = page.getByTestId('nova-lista-modal');
    await expect(modal).toBeVisible();

    // Type something so cancel provably discards a non-empty draft.
    await page.getByTestId('nova-lista-input').fill(randomTitulo());
    await page.getByTestId('nova-lista-cancel').click();
    await expect(modal).toBeHidden();

    await page.waitForTimeout(300);
    expect(criarCalls, 'cancel must fire no campanhas.criar').toHaveLength(0);
    await expect(cards).toHaveCount(before);
  });
});
