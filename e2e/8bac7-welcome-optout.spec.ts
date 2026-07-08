/**
 * aperture-8bac7 — welcome-modal OPT-OUT regression matrix (aperture-opfsj,
 * PR #327).
 *
 * The behavior change under test: dismissing the modal NO LONGER persists the
 * dismissed flag by default. Persistence happens ONLY when the user checks the
 * `welcome-modal-optout` box ("não ver novamente"). All four dismiss paths
 * (OK, SABER MAIS, overlay-click, Escape) funnel through the same
 * dismissWelcome() and must honor the checkbox identically.
 *
 * NOTE: this SUPERSEDES the pre-#327 assertion in
 * e2e/8jcec-campanhas-multicampanha.spec.ts that "OK persists the flag" —
 * that test is updated in the same PR to the new semantics.
 *
 * Matrix (legacy-matching user, fresh context per test = first-visit state):
 *   unchecked × {OK, Escape, overlay, SABER MAIS} → flag ABSENT → modal
 *     reappears on reload
 *   checked × {OK, SABER MAIS}                    → flag SET   → modal gone
 *     on reload
 *   SABER MAIS (either way) additionally opens the tour
 *   pure-2.0 gate: covered in 8jcec spec (legado.length===0 → no modal ever)
 */
import { CAMPANHAS_WELCOME_STORAGE_KEY } from '../apps/eunenem-server/pages/lib/campanhas.js';
import { expect, test } from './legacy-fixtures.js';

const FLAG = CAMPANHAS_WELCOME_STORAGE_KEY;

async function readFlag(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), FLAG);
}

test.describe('welcome-modal opt-out — unchecked dismissals do NOT persist', () => {
  for (const path of ['ok', 'escape', 'overlay', 'saber-mais'] as const) {
    test(`unchecked + ${path} → flag absent → modal reappears on reload`, async ({
      legacyPage,
    }) => {
      await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      const modal = legacyPage.getByTestId('welcome-modal');
      await expect(modal).toBeVisible();
      // Deliberately DO NOT touch the opt-out checkbox.

      switch (path) {
        case 'ok':
          await legacyPage.getByTestId('welcome-modal-ok').click();
          break;
        case 'escape':
          await legacyPage.keyboard.press('Escape');
          break;
        case 'overlay':
          // Click the overlay OUTSIDE the modal card — top-left corner is
          // safely off the centered card at the default viewport.
          await legacyPage
            .locator('.camp-overlay')
            .first()
            .click({ position: { x: 8, y: 8 } });
          break;
        case 'saber-mais':
          await legacyPage.getByTestId('welcome-modal-saber-mais').click();
          break;
      }

      await expect(modal).toBeHidden();
      expect(await readFlag(legacyPage), `${path} without opt-out must NOT persist`).toBeNull();

      if (path === 'saber-mais') {
        // SABER MAIS additionally opens the tour — dismiss it so the reload
        // below starts clean. (Tour has no testid — tracked as a nit with
        // Vance; class selector is the current contract.)
        await expect(legacyPage.locator('.camp-overlay-tour')).toBeVisible();
        await legacyPage.keyboard.press('Escape');
      }

      await legacyPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        legacyPage.getByTestId('welcome-modal'),
        'unchecked dismiss must let the recadinho greet the user again next visit',
      ).toBeVisible();
    });
  }
});

test.describe('welcome-modal opt-out — checked dismissals persist', () => {
  for (const path of ['ok', 'saber-mais'] as const) {
    test(`checked + ${path} → flag set → modal gone on reload`, async ({ legacyPage }) => {
      await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
      const modal = legacyPage.getByTestId('welcome-modal');
      await expect(modal).toBeVisible();

      await legacyPage.getByTestId('welcome-modal-optout').check();

      if (path === 'ok') {
        await legacyPage.getByTestId('welcome-modal-ok').click();
      } else {
        await legacyPage.getByTestId('welcome-modal-saber-mais').click();
      }

      await expect(modal).toBeHidden();
      expect(await readFlag(legacyPage), `${path} WITH opt-out must persist`).toBe('1');

      if (path === 'saber-mais') {
        // Checkbox must not swallow the tour behavior.
        await expect(legacyPage.locator('.camp-overlay-tour')).toBeVisible();
        await legacyPage.keyboard.press('Escape');
      }

      await legacyPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(legacyPage.getByTestId('campanhas-grid')).toBeVisible();
      await expect(legacyPage.getByTestId('welcome-modal')).toHaveCount(0);
    });
  }
});

test.describe('welcome-modal opt-out — interaction details', () => {
  test('checkbox toggling: check then UNcheck then dismiss → not persisted (last state wins)', async ({
    legacyPage,
  }) => {
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await expect(legacyPage.getByTestId('welcome-modal')).toBeVisible();

    const box = legacyPage.getByTestId('welcome-modal-optout');
    await box.check();
    await box.uncheck();
    await legacyPage.getByTestId('welcome-modal-ok').click();

    expect(await readFlag(legacyPage), 'unchecked-at-dismiss must win').toBeNull();
  });

  test('Escape while the TOUR is open closes the tour, not double-dismisses (no flag side-effect)', async ({
    legacyPage,
  }) => {
    await legacyPage.goto('/campanhas', { waitUntil: 'domcontentloaded' });
    await expect(legacyPage.getByTestId('welcome-modal')).toBeVisible();
    await legacyPage.getByTestId('welcome-modal-saber-mais').click();
    await expect(legacyPage.locator('.camp-overlay-tour')).toBeVisible();

    await legacyPage.keyboard.press('Escape');
    await expect(legacyPage.locator('.camp-overlay-tour')).toBeHidden();
    expect(await readFlag(legacyPage), 'tour-Escape must not persist anything').toBeNull();
  });
});
