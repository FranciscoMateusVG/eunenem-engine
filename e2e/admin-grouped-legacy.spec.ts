/**
 * Admin campaign view — collapses legacy multi-row contribuições into ONE
 * grouped card (aperture-8ro9v, E2E Phase 1.2).
 *
 * Pre-create-flow-rewrite legacy data stored a multi-slot gift as N separate
 * contribuição rows, each with quantidade=1, all sharing the same
 * (nome, valor, idOpcaoContribuicao). `groupRows` in ContribuicoesList.tsx
 * buckets those into ONE ContribuicaoGroup of groupSize=N. When groupSize>1
 * the row renders a "× N slots" chip (title="… linhas legadas agrupadas …").
 *
 * This test seeds 4 such legacy rows (same shared nome, same valor, qty=1
 * each) and asserts the admin campaign view renders ONE row for that nome,
 * carrying a "× 4 slots" chip.
 *
 * The admin routes have NO auth gate (operator directive — anyone with the
 * URL gets in), so we use the default anonymous `page` fixture.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Admin campaign view — grouped legacy contribuições', () => {
  test('collapses 4 legacy multi-rows into ONE card showing a "× 4 slots" chip', async ({
    page,
    seededData,
  }) => {
    const LEGACY_ROWS = 4;
    // Unique shared name so the grouper keys 4 identical qty=1 rows into one
    // group, and so our assertions scope to ONLY this group (the campaign
    // also carries the fixture's default gift + possibly others).
    const sharedName = `Legacy Fralda E2E ${randomUUID().slice(0, 8)}`;
    const valorCents = 7000;

    // Seed N legacy rows: same nome + same valor + same opção, each qty=1.
    const db = createDatabase(DATABASE_URL);
    try {
      const repos = buildSeedGiftRepos(db);
      for (let i = 0; i < LEGACY_ROWS; i++) {
        await seedAvailableGift(repos, {
          idCampanha: seededData.idCampanha,
          idOpcaoPresentes: seededData.idOpcaoPresentes,
          nome: sharedName,
          valorCents,
          quantidade: 1,
        });
      }
    } finally {
      await db.destroy();
    }

    // Anonymous admin view of the campaign (no auth gate).
    await page.goto(`/admin/campanha/${seededData.idCampanha}`);

    // The "catálogo · slots da campanha" section is collapsed by default —
    // expand it so ContribuicoesList renders, then wait for tRPC to load.
    const catalogoToggle = page.getByRole('button', { name: /catálogo/i });
    await expect(catalogoToggle).toHaveAttribute('aria-expanded', 'false');
    await catalogoToggle.click();
    await expect(catalogoToggle).toHaveAttribute('aria-expanded', 'true');

    // The list renders one <li> per group. Scope to OUR shared name.
    const rows = page.locator('li').filter({ hasText: sharedName });

    // Exactly ONE row/card for the shared name — the 4 legacy rows collapsed.
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toBeVisible();

    // The "× N slots" chip — located by its title attr — reflects 4 grouped
    // legacy rows. Chip text is "× 4 slots" (groupSize rendered between the
    // "× " prefix and the " slots" suffix).
    const slotChip = row.locator('[title*="linhas legadas agrupadas"]');
    await expect(slotChip).toBeVisible();
    await expect(slotChip).toHaveText(/×\s*4\s*slots/);
    await expect(slotChip).toHaveAttribute(
      'title',
      `${LEGACY_ROWS} linhas legadas agrupadas (cada uma com quantidade=1)`,
    );
  });
});
