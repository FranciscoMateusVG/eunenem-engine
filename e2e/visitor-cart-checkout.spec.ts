/**
 * Visitor cart → Stripe checkout phase (aperture-8ro9v, E2E Phase 1.2).
 *
 * A visitor can add a seeded available gift to the cart and finalize, driving
 * the drawer into its STRIPE CHECKOUT phase. We deliberately do NOT assert the
 * real Stripe iframe: the :3002 server runs with empty Stripe env, so the
 * publishable key is empty and the real EmbeddedCheckout never mounts. That is
 * brittle to assert on. Instead we assert the app-level phase transition:
 *
 *   1. the pagina.iniciarPagamentoCarrinho tRPC mutation returns 2xx, AND
 *   2. the drawer HEADER flips to "Finalizando compra" — DrawerHeader renders
 *      this title for any phase.kind === "checkout" (CartDrawer.tsx ~L318),
 *      which is set the moment the mutation resolves (onFinalizar ~L159),
 *      independent of whether the Stripe iframe mounts.
 *
 * The seededData fixture already seeds ONE available gift
 * (seededData.nomeContribuicao) plus a PIX recebedor, so the saga can
 * initiate payment without extra seeding.
 */
import { expect, test } from './fixtures.js';

test.describe('Visitor cart — Stripe checkout phase', () => {
  test('a visitor can add a gift to the cart and reach the Stripe checkout phase', async ({
    page,
    seededData,
  }) => {
    const giftName = seededData.nomeContribuicao;

    // Anonymous visitor view of the public campaign page.
    await page.goto(`/pagina/${seededData.slug}`);

    // Locate the seeded available gift's card by its unique name.
    const card = page.locator('article').filter({ hasText: giftName });
    await expect(card).toBeVisible();

    // Add it to the cart. onAdd (Marketplace.tsx) adds 1 + opens the drawer.
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();

    // The drawer (role=dialog/aria-modal) auto-opens on add. If for any reason
    // it isn't open, the CartButton in the navbar opens it.
    const drawer = page.getByRole('dialog');
    if (!(await drawer.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /Abrir carrinho/i }).click();
    }
    await expect(drawer).toBeVisible();

    // The finalize button calls pagina.iniciarPagamentoCarrinho.
    const finalizar = drawer.getByRole('button', { name: /Finalizar compra/i });
    await expect(finalizar).toBeEnabled();

    // Arm the response wait BEFORE clicking — tRPC httpBatchLink POSTs to
    // /api/trpc/... with the proc name in the URL.
    const responsePromise = page.waitForResponse(
      (res) => res.url().includes('iniciarPagamentoCarrinho') && res.request().method() === 'POST',
    );

    await finalizar.click();

    // (1) tRPC mutation returns 2xx.
    const response = await responsePromise;
    expect(response.status(), 'iniciarPagamentoCarrinho should return 2xx').toBeGreaterThanOrEqual(
      200,
    );
    expect(response.status()).toBeLessThan(300);

    // (2) The drawer transitions to the checkout phase — header flips to
    // "Finalizando compra" (scoped to the drawer dialog).
    await expect(drawer.getByText('Finalizando compra')).toBeVisible();
  });
});
