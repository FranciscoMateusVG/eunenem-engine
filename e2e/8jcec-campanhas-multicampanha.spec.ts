/**
 * aperture-8jcec — /campanhas multicampanha migration bridge E2E (epic aperture-7hm2g).
 *
 * User-path spec (design spec §9) against Vance's CampanhasPage (PR #321) +
 * Rex's campanhas.list (PR #320):
 *   - legacy-matching user sees the mixed grid: 1.0 card + 2.0 card + NOVA LISTA
 *   - 1.0 card is a REAL anchor to the silent-login bridge /api/legacy-bridge
 *     (post-#325; 302s into the legacy system). We assert the attribute — no
 *     cross-navigation into prod Clerk from CI; the Clerk leg is covered by
 *     the operator-assisted walk, per verify-user-path
 *   - 2.0 card CTA navigates to the user's /painel/:slug (clicked, not just seen)
 *   - welcome modal: first-visit shows (legado > 0 + flag absent), OK dismisses
 *     within-session. Post-#327 the dismiss×opt-out persistence matrix lives in
 *     e2e/8bac7-welcome-optout.spec.ts
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

import { test as base, expect } from '@playwright/test';
import {
  CAMPANHAS_WELCOME_STORAGE_KEY,
  LEGACY_BRIDGE_PATH,
} from '../apps/eunenem-server/pages/lib/campanhas.js';
import { test as seededTest } from './fixtures.js';
// Legacy-user fixture extracted to legacy-fixtures.ts (aperture-8bac7) so the
// welcome-optout spec shares the same self-healing seed.
import { test } from './legacy-fixtures.js';

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
    // UPDATED for aperture-as0v3 (PR #325): the 1.0 CTA now points at the
    // silent-login bridge (302s into the legacy system authenticated, falls
    // back to /minha-area). Attribute assertion only — the bridge crosses to
    // prod Clerk, which stays in the operator-assisted walk.
    const legadoCta = cardLegado.locator(`a[href="${LEGACY_BRIDGE_PATH}"]`);
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
