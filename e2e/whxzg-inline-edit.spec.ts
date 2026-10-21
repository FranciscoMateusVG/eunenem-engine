import { expect, test } from './fixtures.js';

test('editor centralizado: prévia temporária, cancelar, salvar, reload e mobile', async ({
  authenticatedPage: page,
  seededData,
}) => {
  await page.goto(`/pagina/${seededData.slug}`);
  await page.getByRole('link', { name: 'Personalizar página', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fotos da página' })).toBeVisible();
  const primary = page.getByLabel('Selecionar cor principal personalizada', { exact: true });
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
  await primary.fill('#123456');
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await expect(page.getByText('Alterações salvas! Feito com carinho ♡')).toBeVisible();
  await page.reload();
  await expect(primary).toHaveValue('#123456');
  for (const width of [320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('.personalizar-preview')).toHaveAttribute(
      'data-preview-device',
      width === 1440 ? 'desktop' : 'mobile',
    );
    const thumbs = await page
      .locator('.personalizar-photos .perfil-foto-dropzone')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    expect(thumbs).toHaveLength(3);
    expect(new Set(thumbs.map((box) => Math.round(box.y))).size).toBe(1);
    for (const box of thumbs) expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const frameBox = await page.locator('iframe[title="Prévia real da página"]').boundingBox();
    expect(frameBox).not.toBeNull();
    if (!frameBox) throw new Error('Prévia ausente');
    expect(frameBox.x).toBeGreaterThanOrEqual(0);
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(width);
  }
  await expect(page.getByRole('button', { name: 'Mobile', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Desktop', exact: true })).toHaveCount(0);
  await expect(page.locator('.personalizar-color input[type="text"]')).toHaveCount(0);
  await expect(page.locator('.personalizar-custom')).toHaveCount(2);
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
