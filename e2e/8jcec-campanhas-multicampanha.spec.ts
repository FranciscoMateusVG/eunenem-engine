/**
 * aperture-8jcec — /campanhas multicampanha migration bridge E2E (epic aperture-7hm2g).
 *
 * User-path spec (design spec §9) against Vance's CampanhasPage (PR #321) +
 * Rex's campanhas.list (PR #320):
 *   - aperture-gejcw (operator reversal of 6ykni): the 1.0 bridge card is
 *     RESTORED for a legacy-matching user — relabeled (no "Legado" word, 1.0
 *     selo) with an env-driven CTA (LEGACY_SITE_ORIGIN → /migracao)
 *   - 2.0 card CTA navigates to the user's /painel/:slug (clicked, not just seen)
 *   - welcome modal: first-visit shows (legado > 0 + flag absent), OK dismisses
 *     within-session. Post-#327 the dismiss×opt-out persistence matrix lives in
 *     e2e/8bac7-welcome-optout.spec.ts
 *   - pure-2.0 user: no 1.0 card, no welcome modal
 *   - anonymous: route resolves 200 (status asserted FIRST — playwright-gotchas §3)
 *     then client-side bounce to /
 *   - NOVA LISTA: opens the real create modal (campanhas.criar shipped via
 *     #331/#332). Smoke here; the full create-flow walk lives in
 *     u38rz-nova-lista-create.spec.ts.
 *
 * LEGACY SEED: the repo-shipped legacy-1.0-users.json contains exactly the
 * operator email, so the legacy-path tests authenticate as a local user
 * registered with that email. The seed is IDEMPOTENT (register-or-login):
 * first run registers (unique-email constraint), later runs just mint a session.
 */

import { test as base, expect } from '@playwright/test';
import {
  CAMPANHAS_WELCOME_STORAGE_KEY,
  LEGACY_MIGRACAO_URL,
} from '../apps/eunenem-server/pages/lib/campanhas.js';
import { test as seededTest } from './fixtures.js';
// Legacy-user fixture extracted to legacy-fixtures.ts (aperture-8bac7) so the
// welcome-optout spec shares the same self-healing seed.
import { test } from './legacy-fixtures.js';

test.describe('/campanhas — legacy-matching user (the POC user path, spec §9)', () => {
  test('grid renders 2.0 card + the 1.0 bridge card + NOVA LISTA (aperture-gejcw restore)', async ({
    legacyPage,
  }) => {
    const res = await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    expect(res, 'goto must return a Response').toBeTruthy();
    expect(res?.status(), '/campanhas must resolve 200 for an authed user').toBe(200);

    const grid = legacyPage.getByTestId('campanhas-grid');
    await expect(grid).toBeVisible();

    // aperture-gejcw (operator reversal of 6ykni): the 1.0 bridge card is
    // RESTORED for a legacy-matching user — relabeled (no "Legado" word, 1.0
    // selo) with an env-driven CTA out to the old site's /migracao explainer.
    const cardLegado = legacyPage.getByTestId('card-legado').first();
    await expect(cardLegado).toBeVisible();
    await expect(cardLegado).toContainText('1.0');
    // CTA href is env-driven (LEGACY_MIGRACAO_URL override, else derived from
    // LEGACY_SITE_ORIGIN + /migracao). Resolved non-null in the test env.
    expect(LEGACY_MIGRACAO_URL, 'legacy CTA must resolve in the test env').toBeTruthy();
    await expect(cardLegado.locator(`a[href="${LEGACY_MIGRACAO_URL}"]`)).toBeVisible();

    // 2.0 card — visible, selo text, CTA points at the multicampanha
    // /painel/:slug/c/:idCampanha URL (CampanhasPage.tsx:581). The
    // pre-migration slug-only shape was retired when /c/:idCampanha
    // routing landed.
    const cardNova = legacyPage.getByTestId('card-campanha').first();
    await expect(cardNova).toBeVisible();
    await expect(cardNova).toContainText('2.0');
    await expect(cardNova.locator('a.camp-cta')).toHaveAttribute(
      'href',
      /^\/painel\/[a-z][a-z0-9-]{2,29}\/c\/[0-9a-f-]{36}$/,
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
    await legacyPage.waitForURL(/\/painel\/[a-z][a-z0-9-]{2,29}\/c\/[0-9a-f-]{36}$/);
    // Destination is a real page, not the not-found shell.
    await expect(legacyPage.locator('body')).not.toContainText('Página não encontrada');
  });

  test('NOVA LISTA click opens the create modal (real flow — deep coverage in u38rz-nova-lista-create.spec.ts)', async ({
    legacyPage,
  }) => {
    // REWRITTEN 2026-07-08: campanhas.criar shipped (#331/#332, aperture-rurre
    // + x0unf) — the POC stub toast this test used to pin is gone, replaced by
    // the real name-only create modal. This keeps the SMOKE assertion on the
    // POC user path (the CTA does something real); the full create-flow walk
    // (happy/validation/error/cancel) lives in u38rz-nova-lista-create.spec.ts.
    await legacyPage.addInitScript(
      ([key]) => window.localStorage.setItem(key, '1'),
      [CAMPANHAS_WELCOME_STORAGE_KEY],
    );
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await legacyPage.getByTestId('card-nova-lista').click();
    await expect(legacyPage.getByTestId('nova-lista-modal')).toBeVisible();
    await expect(legacyPage.getByTestId('nova-lista-input')).toBeVisible();
  });

  test('welcome modal: first visit shows; OK dismisses within-session', async ({ legacyPage }) => {
    // UPDATED for aperture-opfsj (PR #327): a plain dismiss NO LONGER persists
    // the flag — persistence requires the opt-out checkbox. The full dismiss ×
    // checkbox matrix lives in e2e/8bac7-welcome-optout.spec.ts; this test
    // keeps the first-visit trigger + within-session dismissal pin only.
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
    expect(flag, 'plain dismiss must NOT persist (post-#327 semantics)').toBeNull();
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
    'onboarded pure-2.0 user sees 2.0 card + NOVA LISTA but NO 1.0 card and NO welcome modal',
    async ({ authenticatedPage, seededData }) => {
      // seededData mints a random @e2e.local email — guaranteed absent from
      // legacy-1.0-users.json.
      //
      // aperture-w3rrd — the fresh seed is un-onboarded (auth.me self-heal
      // makes an UNNAMED campanha → needsOnboarding=true post-#29), so the new
      // /campanhas gate correctly PUSHES it into the onboarding wizard (that
      // push is covered by the tqp4t GAP-3 spec). This test asserts the
      // migration-bridge surface for a NON-legacy user who is actually ON
      // /campanhas — so onboard first (gf733 wizard-drive), then assert.
      await authenticatedPage.goto(`/painel/${seededData.slug}`, {
        waitUntil: 'domcontentloaded',
      });
      const wizard = authenticatedPage.getByRole('dialog', {
        name: 'Vamos montar sua página',
      });
      await expect(wizard, 'fresh seed must be gated by the wizard').toBeVisible();
      await authenticatedPage.locator('#ob-name').fill(seededData.nomeExibicao);
      await authenticatedPage.locator('#ob-baby').fill('Bebe 8jcec');
      await authenticatedPage.getByRole('button', { name: /próximo/ }).click();
      await authenticatedPage.locator('#ob-date').fill('2030-01-01');
      await authenticatedPage.getByRole('button', { name: /próximo/ }).click();
      await authenticatedPage.getByRole('button', { name: /criar minha página/ }).click();
      // A successful save reloads /painel with needsOnboarding now false, which
      // CLOSES the wizard (gf733's completion signal). We're already on the
      // /painel/<slug> URL, so wait on the wizard closing — NOT on the URL,
      // which would match immediately and race ahead of the save.
      await expect(
        wizard,
        'onboarding must complete (wizard closes on the post-save reload)',
      ).toBeHidden({ timeout: 15000 });

      // Now the onboarded pure-2.0 user renders /campanhas normally (the gate
      // no longer fires): 2.0 grid + card + NOVA LISTA, and NO 1.0 surface.
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

seededTest(
  'compact cards at six widths preserve decoration and whole-card navigation',
  async ({ authenticatedPage: page, seededData }) => {
    // Only read responses are adapted for deterministic layout; creation is covered above.
    await page.route('**/api/trpc/**', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const batch = Array.isArray(data) ? data : [data];
      const calls = new URL(route.request().url()).pathname.split('/api/trpc/')[1].split(',');
      calls.forEach((call, index) => {
        if (call === 'auth.me') batch[index].result.data.needsOnboarding = false;
        if (call === 'campanhas.list') {
          const first = batch[index].result.data.novas[0];
          batch[index].result.data.legado = [];
          batch[index].result.data.novas = [
            'Chá da Helena',
            'Uma lista com um nome muito longo para a chegada do nosso bebê querido',
            'Quartinho ♡',
          ].map((titulo, i) => ({
            ...first,
            id: i === 0 ? first.id : `00000000-0000-4000-8000-00000000000${i}`,
            titulo,
            nomeBebe: 'Helena',
          }));
        }
        if (call === 'perfilCampanha.get')
          batch[index] = {
            result: {
              data: {
                fotoPerfilUrl:
                  'data:image/svg+xml,' +
                  encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#dac4e8"/></svg>',
                  ),
              },
            },
          };
      });
      await route.fulfill({ response, json: Array.isArray(data) ? batch : batch[0] });
    });
    await page.goto('/campanhas');
    const cards = page.getByTestId('card-campanha');
    await expect(cards).toHaveCount(3);
    for (const width of [320, 375, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width <= 430) {
        expect(
          await page.locator('.camp-hero-title').evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        const bounds = await cards.evaluateAll((nodes) =>
          nodes.map((el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          }),
        );
        expect(bounds[0].height).toBeLessThan(135);
        expect(bounds[1].top).toBeGreaterThan(bounds[0].bottom);
        expect(bounds[2].bottom).toBeLessThan(800);
      }
      await expect(cards.first().locator('.camp-tape')).toBeVisible();
      await expect(cards.first().locator('img')).toBeVisible();
      expect(
        await cards
          .nth(1)
          .locator('.camp-card-name')
          .evaluate((el) => el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1),
      ).toBe(true);
      await page.screenshot({ path: `test-results/minhas-listas-${width}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: 'como funciona? ♡', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('card-nova-lista').click();
    await expect(page.getByTestId('nova-lista-modal')).toBeVisible();
    await page.getByTestId('nova-lista-cancel').click();
    await cards.first().click({ position: { x: 12, y: 60 } });
    await expect(page).toHaveURL(
      new RegExp(`/painel/${seededData.slug}/c/${seededData.idCampanha}$`),
    );
  },
);
