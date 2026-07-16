/**
 * REGRESSION LOCK — aperture-gf733 / bug A (aperture-5ho5j).
 *
 * BUG (shipped to prod, fixed in 5492cba without a locking test):
 *   OnboardingWizard.finish() (OnboardingWizard.tsx) saved the profile via
 *   perfil.atualizar + perfilCampanha.atualizar, then navigated via onDone().
 *   The catch branch fired onDone() ANYWAY on failure (toast-only feedback).
 *   So a transient perfilCampanha.atualizar 500 closed the wizard / navigated
 *   while the profile stayed empty → the server-derived needsOnboarding
 *   (auth-router: perfil_campanhas.nome_bebe is empty) stayed TRUE → the next
 *   painel load re-gated the wizard → a SILENT loop the user could never
 *   escape.
 *
 * FIX (5492cba): the catch keeps the wizard OPEN — retry-framed toast +
 *   setSubmitting(false); onDone() fires ONLY on the success path.
 *
 * INVARIANT LOCKED HERE:
 *   When the profile save FAILS, finish() does NOT fire onDone() — i.e. NO
 *   navigation happens and the wizard stays open + retryable. A subsequent
 *   retry (save now succeeds) DOES navigate and clear the gate.
 *
 * HOW THIS CATCHES A REGRESSION (proven against the pre-fix behaviour):
 *   onDone here (PainelPage.tsx) is `window.location.assign('/painel/<slug>')`
 *   — a FULL PAGE RELOAD. We plant a window sentinel that only survives if no
 *   navigation occurs. Pre-fix, the catch called onDone() → the reload fired →
 *   the sentinel is wiped. This test asserts the sentinel SURVIVES the forced
 *   500, so it would FAIL against the old fire-onDone-on-failure code. The
 *   retry leg then asserts onDone DOES fire on success (sentinel wiped, wizard
 *   gone), proving the guard is on failure only, not a blanket "never navigate".
 *
 * WHY E2E (not unit): finish() is inline in a React component wired to live
 *   tRPC mutations + BetterAuth session + the server-derived needsOnboarding
 *   gate. The only honest way to lock "onDone fires ONLY on success" is to
 *   drive the real wizard and force the real mutation to 500 via route
 *   interception — which is exactly how 5492cba was verified (Playwright walk).
 *   A fresh per-test seeded user (fixtures.ts) is needsOnboarding=true (its
 *   campanha has no nome_bebe), so the wizard genuinely gates.
 *
 * RUN LOCALLY:
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm test:e2e e2e/gf733-onboarding-no-silent-loop-regression.spec.ts
 */
import { expect, test } from './fixtures.js';

/** tRPC batch-error envelope that makes @trpc/client reject mutateAsync. */
const TRPC_500_BODY = JSON.stringify([
  {
    error: {
      message: 'e2e forced failure (aperture-gf733)',
      code: -32603,
      data: {
        code: 'INTERNAL_SERVER_ERROR',
        httpStatus: 500,
        path: 'perfilCampanha.atualizar',
      },
    },
  },
]);

test.describe('aperture-gf733 / 5ho5j — onboarding does NOT fire onDone on save failure', () => {
  test('a failed profile save keeps the wizard open (no navigation); retry then completes', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // Fresh seeded user is needsOnboarding=true → /painel/<slug> gates the wizard.
    await page.goto(`/painel/${seededData.slug}`, { waitUntil: 'domcontentloaded' });
    const wizard = page.getByRole('dialog', { name: 'Vamos montar sua página' });
    await expect(wizard, 'fresh seeded user must be gated by the onboarding wizard').toBeVisible();

    // Step 1 — display name + baby name.
    await page.locator('#ob-name').fill(seededData.nomeExibicao);
    await page.locator('#ob-baby').fill('Bebe gf733');
    await page.getByRole('button', { name: /próximo/ }).click();

    // Step 2 — event date + type + gender.
    await page.locator('#ob-date').fill('2030-01-01');
    await page.locator('#ob-type').selectOption('cha-bebe');
    await page.locator('#ob-genero').selectOption('surpresa');
    await page.getByRole('button', { name: /próximo/ }).click();

    // Step 3 — keep the signup-derived slug (slugChanged=false → no
    // atualizarSlug hop; the ONLY writes are perfil.atualizar +
    // perfilCampanha.atualizar, matching the prod bug's failing call).
    const finishButton = page.getByRole('button', { name: /criar minha página/ });
    await expect(finishButton).toBeEnabled();

    // Plant a sentinel that a full-page reload (onDone → location.assign) wipes.
    await page.evaluate(() => {
      (window as unknown as { __gf733?: boolean }).__gf733 = true;
    });

    // Force the baby-half write (perfilCampanha.atualizar) to 500 — the exact
    // transient failure that looped users in prod. perfil.atualizar and
    // perfilCampanha.atualizar are awaited sequentially, so httpBatchLink puts
    // them in SEPARATE batches — this override hits only the baby-half.
    // A mutable flag (not page.unroute) flips the SAME handler to pass-through
    // for the retry leg — unroute matches by matcher reference and is brittle.
    let failBabyHalf = true;
    await page.route(
      (url) => url.pathname.includes('/api/trpc/') && url.href.includes('perfilCampanha.atualizar'),
      async (route) => {
        if (failBabyHalf) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: TRPC_500_BODY,
          });
        } else {
          await route.continue();
        }
      },
    );

    await finishButton.click();

    // The catch ran: retry-framed toast (proves failure path, not success).
    await expect(page.getByText(/não consegui salvar agora/i)).toBeVisible();

    // ── THE LOCK: no navigation happened → onDone did NOT fire. ────────────
    // Pre-fix the catch called onDone() → window.location.assign reloaded the
    // page → this sentinel would be gone.
    const survivedFailure = await page.evaluate(
      () => (window as unknown as { __gf733?: boolean }).__gf733 === true,
    );
    expect(
      survivedFailure,
      'a FAILED profile save must NOT navigate — onDone fired on failure is the aperture-5ho5j ' +
        'silent wizard loop (page reloaded, needsOnboarding still true, wizard re-gated)',
    ).toBe(true);

    // Wizard stays open and retryable.
    await expect(wizard, 'wizard must stay OPEN after a failed save').toBeVisible();
    await expect(finishButton, 'finish button must re-enable for a retry').toBeEnabled();

    // ── Retry leg: save now succeeds → onDone DOES fire (guard is failure-only).
    failBabyHalf = false;
    await finishButton.click();

    // Success path reloads to /painel/<slug> with needsOnboarding now false →
    // the wizard is gone. Its disappearance proves onDone fired on success
    // (and the sentinel is wiped by the reload — navigation did occur this time).
    await expect(wizard, 'a successful retry must navigate away — wizard closes').toBeHidden({
      timeout: 20_000,
    });
    const survivedSuccess = await page.evaluate(
      () => (window as unknown as { __gf733?: boolean }).__gf733 === true,
    );
    expect(
      survivedSuccess,
      'the successful retry MUST navigate (reload) — sentinel should be wiped',
    ).toBe(false);
  });
});
