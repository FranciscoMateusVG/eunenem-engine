import { expect, test } from './fixtures.js';

test('editor centralizado: prévia temporária, cancelar, salvar, reload e mobile', async ({
  authenticatedPage: page,
  seededData,
}) => {
  await page.goto(`/pagina/${seededData.slug}`);
  await page.getByRole('link', { name: 'Personalizar página', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fotos da página' })).toBeVisible();
  const primary = page.getByRole('textbox', { name: 'Cor principal', exact: true });
  const original = await primary.inputValue();
  await primary.fill('#123456');
  const preview = page.frameLocator('iframe[title="Prévia real da página"]');
  await expect
    .poll(() =>
      preview
        .locator('html')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--lilac').trim()),
    )
    .toBe('#123456');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(primary).toHaveValue(original);
  await primary.fill('invalid');
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cores válidas');
  await primary.fill('#123456');
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(page.getByText('Alterações salvas! Feito com carinho ♡')).toBeVisible();
  await page.reload();
  await expect(primary).toHaveValue('#123456');
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await expect(page.locator('iframe[title="Prévia real da página"]')).toHaveCSS('width', '390px');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(preview.locator('[inert]')).toBeVisible();
  await page.goto(`/painel/${seededData.slug}/perfil`);
  await expect(page.getByText('Personalizar fotos e cores da página →')).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});

test('convidado não recebe controles de edição', async ({ page, seededData }) => {
  await page.goto(`/pagina/${seededData.slug}`);
  await expect(page.getByTestId('pagina-baby-name')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Personalizar página', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-edit-field]')).toHaveCount(0);
});
