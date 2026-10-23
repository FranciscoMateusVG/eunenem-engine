import { expect, test } from '@playwright/test';

for (const width of [320, 375, 390, 430, 768, 1440]) {
  test(`public fees page remains readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto('/taxas-e-prazos');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('taxas e prazos ♡');
    await expect(page.locator('.taxas-info-validade')).toContainText('13/09/2026');
    await expect(page.locator('.taxas-info-recebe')).toContainText('R$ 50,00');
    await expect(page.locator('.taxas-info-pix')).toContainText('até 10 minutos');
    await expect(page.locator('.taxas-info-card')).toContainText('31 dias corridos');
    await expect(page.locator('.taxas-info-withdrawal')).toContainText('até 3 dias úteis');
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Perguntas frequentes' }),
    ).toHaveAttribute('href', '/faq');
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Fale com a gente' }),
    ).toHaveAttribute('href', 'https://wa.me/5531996011432');
    await expect(
      page.getByRole('link', { name: 'Consulte também nossos Termos de Uso.' }),
    ).toHaveAttribute('href', '/termos-de-uso');
    const footerLink = page.locator('footer a[href="/taxas-e-prazos"]:visible');
    await expect(footerLink).toHaveCount(1);
    await expect(footerLink).toHaveText('Taxas e prazos');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
