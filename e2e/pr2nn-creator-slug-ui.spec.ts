import { expect, test } from './fixtures.js';

test.describe('PR2NN creator public-link UI', () => {
  test('onboarding edits the creator slug and the resulting public URL resolves', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    await page.goto(`/painel/${seededData.slug}`, { waitUntil: 'domcontentloaded' });
    const wizard = page.getByRole('dialog', { name: 'Vamos montar sua página' });
    await expect(wizard).toBeVisible();

    await page.locator('#ob-name').fill(seededData.nomeExibicao);
    await page.locator('#ob-baby').fill('Bebe PR2NN');
    await page.getByRole('button', { name: /próximo/ }).click();
    await page.locator('#ob-date').fill('2030-01-01');
    await page.locator('#ob-type').selectOption('cha-bebe');
    await page.locator('#ob-genero').selectOption('surpresa');
    await page.getByRole('button', { name: /próximo/ }).click();

    const chosenSlug = `p-${seededData.slug}`.slice(0, 30).replace(/-+$/g, '');
    await page.locator('#ob-slug').fill(chosenSlug);
    await expect(page.getByText('disponível ♡', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /criar minha página/ }).click();
    await expect(wizard).toBeHidden({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`/painel/${chosenSlug}(?:/|$)`));

    const publicResponse = await page.goto(`/pagina/${chosenSlug}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(publicResponse?.status()).toBe(200);
    await expect(page.getByTestId('pagina-baby-name')).toHaveText('Bebe PR2NN');
  });
});
