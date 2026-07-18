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
