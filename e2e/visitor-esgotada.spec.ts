/**
 * Visitor page — fully ESGOTADA gift disables "Adicionar" (aperture-8ro9v #3).
 *
 * A gift whose every unit is sold (status derived from approved pagamentos)
 * must render as taken: the card shows a DISABLED "Já presenteado ♡" button
 * and offers NO "+ Adicionar" button — a visitor can't add a sold-out gift
 * to their cart.
 *
 * Uses the shared seedSoldOutGift helper (seeds the contribuição + one
 * approved Pagamento covering the full quantidade → quantidadeRestante 0 →
 * grouper status 'presenteado'). The seeded campaign also carries an available
 * gift (from the seededData fixture), so this also implicitly proves the
 * sold-out card is distinguished from available ones.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedSoldOutGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Visitor page — esgotada gift', () => {
  test('a fully sold-out gift renders "Já presenteado" disabled and no "+ Adicionar"', async ({
    page,
    seededData,
  }) => {
    const soldOutName = `Esgotado E2E ${randomUUID().slice(0, 8)}`;

    // Seed a fully sold-out gift on the same campaign the visitor will browse.
    const db = createDatabase(DATABASE_URL);
    try {
      const repos = buildSeedGiftRepos(db);
      await seedSoldOutGift(repos, {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: soldOutName,
        valorCents: 5000,
        quantidade: 1,
      });
    } finally {
      await db.destroy();
    }

    // Anonymous visitor view of the public campaign page.
    await page.goto(`/pagina/${seededData.slug}`);

    // Locate the sold-out gift's card by its unique name.
    const card = page.locator('article').filter({ hasText: soldOutName });
    await expect(card).toBeVisible();

    // The card shows a DISABLED "Já presenteado" button…
    const takenBtn = card.getByRole('button', { name: /Já presenteado/i });
    await expect(takenBtn).toBeVisible();
    await expect(takenBtn).toBeDisabled();

    // …and offers NO "+ Adicionar" button (you can't cart a sold-out gift).
    await expect(card.getByRole('button', { name: /Adicionar/i })).toHaveCount(0);
  });
});
