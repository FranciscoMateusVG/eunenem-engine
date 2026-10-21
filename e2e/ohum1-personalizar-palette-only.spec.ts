import { expect, test } from './fixtures.js';

test('personalização salva cores sem alterar identidade; Perfil preserva a paleta', async ({
  authenticatedPage: page,
  seededData,
}) => {
  await page.goto(`/painel/${seededData.slug}/personalizar`);
  await page.getByRole('button', { name: 'Cor principal #9CD7DD', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(page.getByText('Alterações salvas! Feito com carinho ♡')).toBeVisible();
  await page.goto(`/painel/${seededData.slug}/perfil`);
  await expect(page.locator('#perfil-papais')).toBeVisible();
  await page.locator('#perfil-baby').fill('Helena E2E');
  await page.locator('#perfil-papais').fill('Mari & Rodrigo E2E');
  await page.getByRole('button', { name: /salvar alterações/i }).click();
  await expect(page.getByText('Tudo salvo! Feito com carinho ♡')).toBeVisible();
  await page.goto(`/painel/${seededData.slug}/personalizar`);
  await expect(page.getByRole('textbox', { name: 'Cor principal', exact: true })).toHaveValue(
    '#9CD7DD',
  );
  await expect(page.frameLocator('iframe').getByTestId('pagina-baby-name')).toContainText(
    'Helena E2E',
  );
});
