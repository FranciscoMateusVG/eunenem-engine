/**
 * aperture-gu7u6 — changing the cart after a checkout was generated must NOT
 * reopen the old checkout.
 *
 * Operator repro (01/11): visitor puts one gift in the cart, generates a PIX
 * (QR shown), closes the drawer, adds a second gift → the drawer reopened
 * straight on "Finalizando compra / paga com pix — R$ <old total>" instead of
 * the cart with both items and the new total.
 *
 * Expected: a cart change (items / quantity) invalidates the pending checkout
 * screen and lands on the summary with the updated total; finalizing again
 * issues a NEW operation (different request fingerprint) for the new amount.
 * The old charge is left untouched (still valid if paid later — reconciliation
 * is server-side), and it is never re-shown for the new cart.
 *
 * PIX runs against :3004 (COBRANCA_PIX_PROVIDER='fake' → our QR flow); the
 * card leg runs against the default :3002 server (fake Stripe → the drawer
 * reaches its stripe checkout phase without a real iframe).
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const PIX_SERVER = 'http://localhost:3004';

async function seedTwoGifts(seededData: {
  idCampanha: string;
  idOpcaoPresentes: string;
}): Promise<{ primeiro: string; segundo: string }> {
  const tag = randomUUID().slice(0, 8);
  const primeiro = `Carrinho A ${tag}`;
  const segundo = `Carrinho B ${tag}`;
  const db = createDatabase(DATABASE_URL);
  try {
    const repos = buildSeedGiftRepos(db);
    // Non-magic prices: the fake charge stays 'ativa' so the QR holds still.
    await seedAvailableGift(repos, { ...seededData, nome: primeiro, valorCents: 4200 });
    await seedAvailableGift(repos, { ...seededData, nome: segundo, valorCents: 2500 });
  } finally {
    await db.destroy();
  }
  return { primeiro, segundo };
}

function drawerOf(page: import('@playwright/test').Page) {
  return page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
}

async function addToCart(page: import('@playwright/test').Page, nome: string) {
  const card = page.locator('article').filter({ hasText: nome });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /\+ Adicionar/i }).click();
  await expect(drawerOf(page)).toBeVisible();
}

function waitForCartInitiation(page: import('@playwright/test').Page) {
  return page.waitForResponse(
    async (res) =>
      res.url().includes('iniciarPagamentoCarrinho') &&
      res.request().method() === 'POST' &&
      !(await res.text()).includes('"tipo":"prepared"'),
  );
}

async function generatePix(
  page: import('@playwright/test').Page,
): Promise<{ valorCents: number; txid: string }> {
  const drawer = drawerOf(page);
  await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
  await expect(drawer.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
  await drawer.getByPlaceholder('Ana & João').fill('E2e Carrinho Alterado');
  await drawer.getByPlaceholder('ana@email.com').fill('e2e-gu7u6@e2e.local');
  const initiation = waitForCartInitiation(page);
  await drawer.getByRole('button', { name: 'continuar para o pix ♡' }).click();
  const body = JSON.parse(await (await initiation).text()) as Array<{
    result?: { data?: { valorCents?: number; txid?: string } };
  }>;
  const data = body[0]?.result?.data;
  expect(data?.txid, 'pix_qr response must carry a txid').toBeTruthy();
  return { valorCents: data?.valorCents ?? 0, txid: data?.txid ?? '' };
}

function brl(cents: number): RegExp {
  const reais = Math.floor(cents / 100);
  const centavos = String(cents % 100).padStart(2, '0');
  return new RegExp(`paga com pix — R\\$\\s*${reais},${centavos}`);
}

test.describe('gu7u6 — cart change after checkout generated returns to the cart', () => {
  test('PIX: adding an item after the QR was shown reopens the cart with the new total and a new QR', async ({
    page,
    seededData,
  }) => {
    const gifts = await seedTwoGifts(seededData);
    const configLoaded = page.waitForResponse((res) => res.url().includes('obterConfigCheckout'));
    await page.goto(`${PIX_SERVER}/pagina/${seededData.slug}`);
    await configLoaded;

    await addToCart(page, gifts.primeiro);
    const first = await generatePix(page);
    const drawer = drawerOf(page);
    await expect(drawer.getByRole('heading', { name: brl(first.valorCents) })).toBeVisible();

    // Close the QR screen, add another gift.
    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    // Closed outside the summary phase the drawer stays mounted, slid off-screen.
    await expect(drawer).not.toBeInViewport();
    await addToCart(page, gifts.segundo);

    // The drawer must show the CART (both items), not the old PIX screen.
    await expect(drawer.getByRole('heading', { name: brl(first.valorCents) })).toHaveCount(0);
    await expect(drawer.getByText('Seu carrinho')).toBeVisible();
    await expect(drawer.getByText(gifts.primeiro)).toBeVisible();
    await expect(drawer.getByText(gifts.segundo)).toBeVisible();

    // Finalizing again issues a NEW charge for the new amount.
    const second = await generatePix(page);
    expect(second.txid).not.toBe(first.txid);
    expect(second.valorCents).toBeGreaterThan(first.valorCents);
    await expect(drawer.getByRole('heading', { name: brl(second.valorCents) })).toBeVisible();

    // The old charge was not reissued or rewritten: still its own row, own amount.
    const db = createDatabase(DATABASE_URL);
    try {
      const rows = await db
        .selectFrom('pagamentos')
        .select(['intencao_external_ref', 'intencao_total_paid_cents'])
        .where('intencao_external_ref', 'in', [first.txid, second.txid])
        .execute();
      const byRef = new Map(
        rows.map((r) => [r.intencao_external_ref, Number(r.intencao_total_paid_cents)]),
      );
      expect(byRef.get(first.txid)).toBe(first.valorCents);
      expect(byRef.get(second.txid)).toBe(second.valorCents);
    } finally {
      await db.destroy();
    }
  });

  test('cartão: adding an item after the Stripe checkout opened reopens the cart', async ({
    page,
    seededData,
  }) => {
    const gifts = await seedTwoGifts(seededData);
    await page.goto(`/pagina/${seededData.slug}`);

    await addToCart(page, gifts.primeiro);
    const drawer = drawerOf(page);
    await drawer.getByRole('button', { name: /^Cartão/ }).click();
    const firstInitiation = waitForCartInitiation(page);
    await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
    expect((await firstInitiation).status()).toBeLessThan(300);
    await expect(drawer.getByText('Finalizando compra')).toBeVisible();

    await drawer.getByRole('button', { name: 'Fechar carrinho' }).click();
    // Closed outside the summary phase the drawer stays mounted, slid off-screen.
    await expect(drawer).not.toBeInViewport();
    await addToCart(page, gifts.segundo);

    await expect(drawer.getByText('Finalizando compra')).toHaveCount(0);
    await expect(drawer.getByText('Seu carrinho')).toBeVisible();
    await expect(drawer.getByText(gifts.segundo)).toBeVisible();

    // A fresh checkout carries both items.
    const secondInitiation = waitForCartInitiation(page);
    await drawer.getByRole('button', { name: /Finalizar compra/ }).click();
    const request = (await secondInitiation).request().postData() ?? '';
    expect(request.match(/idContribuicao/g)?.length).toBe(2);
    await expect(drawer.getByText('Finalizando compra')).toBeVisible();
  });
});
