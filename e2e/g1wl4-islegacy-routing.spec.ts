/**
 * aperture-g1wl4 — LEGACY-FIRST post-login routing (Bug 1, 2026-07-08
 * migration test; backend PR #342 + frontend PR #341).
 *
 * WHAT IS UNDER TEST: after an OAuth return, a user whose email matches the
 * repo-shipped legacy-1.0-users.json snapshot lands on /campanhas (the
 * migration hub with their 1.0 card) — NEVER on /painel/:slug with the
 * onboarding wizard, even when their 2.0 profile is un-onboarded. The gate
 * sites (useOauthReturnRedirect.ts + AuthModalProvider.tsx) share the
 * reordered decision expression:
 *
 *   const target = isLegacy(me)
 *     ? '/campanhas'
 *     : needsOnboarding(me)
 *       ? `/painel/${me.slug}`
 *       : '/campanhas';
 *
 * where `isLegacy` comes from auth.me — derived SERVER-SIDE
 * (auth-router.ts `me`) as `buscarCampanhasLegado(usuario.email).length > 0`.
 *
 * DESIGN — mirrors e2e/8bac7-postlogin-routing.spec.ts exactly:
 *  - NO auth.me mocking: real session cookie, real server-side isLegacy /
 *    needsOnboarding derivation. Real derivation beats mock drift.
 *  - OAUTH-RETURN SIMULATION: valid BetterAuth session cookie + goto
 *    '/?oauth=1' — byte-for-byte what the real Google callback leaves behind.
 *  - Welcome-modal gotcha: /campanhas shows a welcome modal for
 *    legacy-matching users; CAMPANHAS_WELCOME_STORAGE_KEY='1' is pre-seeded
 *    via addInitScript so it can never intercept assertions.
 *
 * PERFIL-STATE INDEPENDENCE (why the legacy fixture's idempotency is safe):
 * mintLegacySession self-heals across dev-DB states, so the legacy user may
 * or may not already carry a PerfilCriador row from prior wizard runs. That
 * does NOT matter here: for isLegacy=true BOTH branches of needsOnboarding
 * resolve to '/campanhas' (see the expression above — legacy short-circuits
 * before the wizard gate is even consulted). The assertion "lands /campanhas,
 * no wizard" is therefore valid in EITHER perfil state, and the un-onboarded
 * state (the literal Bug-1 scenario) is additionally pinned deterministically
 * by the unit matrix (tests/unit/server/g1wl4-islegacy-gate.test.ts) and the
 * router contract suite (tests/unit/server/authme-islegacy.test.ts).
 *
 * CROSS-REFERENCES (NOT duplicated here — covered verbatim by
 * e2e/8bac7-postlogin-routing.spec.ts):
 *  - fresh NON-legacy account → /painel/:slug + wizard BLOCKING (its test
 *    'OAuth return + needsOnboarding=true → lands /painel/:slug with the
 *    wizard BLOCKING') — pins that aperture-ivu2t survived the reorder.
 *  - onboarded non-legacy → /campanhas (its test 'OAuth return + onboarded
 *    user → lands /campanhas with the grid').
 *  - marker-strip + no-marker guardrails (its remaining OAuth-leg tests).
 *
 * DOCUMENTED GAP — the EMAIL-LOGIN leg is not UI-drivable: the auth modal is
 * magic-link-only (no password field), so AuthModalProvider.onAuthenticated
 * cannot be reached end-to-end from the UI. That leg runs the IDENTICAL
 * reordered expression (same onboarding-gate helpers), pinned by the unit
 * matrix plus this OAuth-surface walk — same posture as 8bac7.
 */

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { mintLegacySession } from './legacy-fixtures.js';

const SESSION_COOKIE = 'better-auth.session_token';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** Wizard dialog — OnboardingWizard.tsx renders role=dialog with this label. */
const WIZARD_LABEL = 'Vamos montar sua página';

/**
 * Context with the legacy user's BetterAuth session cookie pre-set (what the
 * OAuth callback leaves behind) + the welcome-modal opt-out flag — mirrors
 * openAuthedPage in 8bac7-postlogin-routing.spec.ts.
 */
async function openLegacyPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const sessionToken = await mintLegacySession();
  const url = new URL(BASE_URL);
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: encodeURIComponent(sessionToken),
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

test.describe('g1wl4 — legacy-first post-login routing (OAuth-return leg)', () => {
  test('OAuth return + LEGACY user → lands /campanhas, NEVER the onboarding wizard (Bug 1 pin)', async ({
    browser,
  }) => {
    const { context, page } = await openLegacyPage(browser);

    await page.goto('/?oauth=1', { waitUntil: 'domcontentloaded' });

    // useOauthReturnRedirect fetches REAL auth.me → isLegacy=true (email
    // matches the committed legacy-1.0-users.json snapshot, case-insensitive)
    // → '/campanhas' regardless of needsOnboarding. Before the #341 reorder,
    // an un-onboarded legacy user was sent to /painel/:slug + wizard — this
    // waitForURL would then time out, which is exactly the regression signal.
    await page.waitForURL('**/campanhas');
    expect(new URL(page.url()).pathname).toBe('/campanhas');

    // The migration hub renders; the onboarding wizard must NOT exist
    // anywhere (the Bug-1 symptom was the blocking wizard dialog).
    await expect(page.getByTestId('campanhas-grid')).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: WIZARD_LABEL }),
      'the onboarding wizard must never mount for a legacy user post-login',
    ).toHaveCount(0);

    await context.close();
  });
});
