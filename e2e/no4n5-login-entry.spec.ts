import { expect, test } from '@playwright/test';

// Read-only and anonymous: this same browser gate can run on staging/prod.
for (const path of ['/login', '/login/']) {
  test(`${path} renders the real 2.0 login modal; return parameters stay inert`, async ({
    page,
    request,
  }) => {
    const url = `${path}?next=https://attacker.invalid&redirect=//attacker.invalid`;
    for (const method of ['GET', 'HEAD']) {
      const response = await request.fetch(url, { method, maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers().location).toBeUndefined();
    }
    const response = await page.goto(url);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(path);
    const dialog = page.getByRole('dialog', { name: 'entrar ou criar sua lista' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continuar com Google' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continuar com Microsoft' })).toBeVisible();
    await expect(dialog.getByLabel('Seu e-mail')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'ENVIAR LINK MÁGICO ♡', exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    const origin = new URL(page.url()).origin;
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`${origin}/`);
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(dialog).toHaveCount(0);
  });
}

test('login namespace cannot redirect into a legacy checkout', async ({ request }) => {
  const response = await request.get('/login/checkout', { maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(response.headers().location).toBeUndefined();
});
