import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test('gift sorting survives null focus transitions and reorders the visible cards', async ({
  page,
  seededData,
}) => {
  const db = createDatabase(DATABASE_URL);
  const names = ['Sort A', 'Sort B', 'Sort C'];
  try {
    const repos = buildSeedGiftRepos(db);
    for (const [index, valorCents] of [2000, 1000, 3000].entries()) {
      await seedAvailableGift(repos, {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: names[index] ?? 'Sort',
        valorCents,
      });
    }
  } finally {
    await db.destroy();
  }
  await page.goto(`/pagina/${seededData.slug}`);
  const search = page.getByRole('searchbox', { name: 'Buscar presente' });
  await search.fill('Sort');
  const headings = page.locator('#presentes article h3');
  await expect(headings).toHaveText(names);
  const summary = page.locator('summary[aria-label="Ordenar presentes"]');
  const choose = async (label: string) => {
    await summary.click();
    // Safari may lose focus without exposing the clicked button as relatedTarget.
    // The option must remain present until its click is dispatched.
    await summary.dispatchEvent('focusout', { relatedTarget: null });
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('group', { name: 'Ordenar por' })).toBeHidden();
  };
  await choose('Menor para o maior preço');
  await expect(headings).toHaveText(['Sort B', 'Sort A', 'Sort C']);
  await choose('Maior para o menor preço');
  await expect(headings).toHaveText(['Sort C', 'Sort A', 'Sort B']);
  await choose('Ordem alfabética (A–Z)');
  await expect(headings).toHaveText(names);
  await summary.click();
  await search.click();
  await expect(page.getByRole('group', { name: 'Ordenar por' })).toBeHidden();
  await summary.click();
  await summary.press('Escape');
  await expect(page.getByRole('group', { name: 'Ordenar por' })).toBeHidden();
});
