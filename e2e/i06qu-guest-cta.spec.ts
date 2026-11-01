/**
 * aperture-i06qu — guest → creator CTA. The guest page shows "Esperando bebê?
 * Crie sua lista grátis" below the mural, linking to signup with
 * guest_to_creator UTMs. Clicking it from a browser whose first touch was the
 * guest page must still record those UTMs as signup first touch (#228).
 */
import { SIGNUP_ATTRIBUTION_KEY } from '../src/domain/usuario/signup-attribution.js';
import { expect, test } from './fixtures.js';

test('guest page CTA opens signup and its UTMs become the first touch', async ({
  page,
  seededData,
}) => {
  await page.goto(`/pagina/${seededData.slug}`);
  await expect(
    page.locator('article').filter({ hasText: seededData.nomeContribuicao }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), SIGNUP_ATTRIBUTION_KEY))
    .toContain(`/pagina/${seededData.slug}`);

  const cta = page.getByTestId('criar-lista-cta');
  await expect(cta.getByRole('heading', { name: 'Crie sua lista grátis' })).toBeVisible();
  await expect(cta).toContainText('esperando bebê?');
  const link = cta.getByRole('link', { name: /criar minha lista grátis/ });
  const href = await link.getAttribute('href');
  const url = new URL(href ?? '', 'http://x');
  expect(url.pathname).toBe('/login');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    utm_source: 'eunenem',
    utm_medium: 'guest_page',
    utm_campaign: 'guest_to_creator',
  });
  await expect(link).toHaveAttribute('target', '_blank');

  const [signup] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await signup.waitForLoadState();
  await expect(signup.getByRole('dialog', { name: 'entrar ou criar sua lista' })).toBeVisible();
  const stored = JSON.parse(
    (await signup.evaluate((k) => localStorage.getItem(k), SIGNUP_ATTRIBUTION_KEY)) ?? '{}',
  );
  expect(stored).toMatchObject({
    utm_source: 'eunenem',
    utm_medium: 'guest_page',
    utm_campaign: 'guest_to_creator',
    landing_path: '/login',
  });
  // The gift flow is untouched: the guest tab is still on the page.
  expect(new URL(page.url()).pathname).toBe(`/pagina/${seededData.slug}`);
});
