/**
 * Visitor page — a LEGACY MULTI-ROW gift carts ONLY the unsold ids
 * (aperture-8ro9v, E2E Phase 1.2).
 *
 * LEGACY MULTI-ROW shape: several contribuição rows sharing the SAME
 * nome + valorCents + idOpcaoPresentes, each quantidade=1. The visitor
 * grouper (groupVisitorGifts, pages/lib/visitorGift.ts ~L164-248)
 * collapses them into ONE card keyed by nome, accumulating qtyTotal and
 * pushing only the UNSOLD row ids onto `availableIds`. The cart's
 * toSagaInput (pages/lib/cart.tsx ~L328-352) fans the chosen quantidade
 * over those availableIds — so a sold row's id can NEVER reach the saga.
 *
 * THE INVARIANT THIS LOCKS DOWN
 * ─────────────────────────────
 * Seed 1 sold + 2 available rows under a single shared name. The card
 * reads "2 de 3 disponíveis". Add it and bump cart qty to 2 (both unsold
 * units). On "Finalizar compra" the tRPC pagina.iniciarPagamentoCarrinho
 * input MUST carry EXACTLY the two unsold contribuição ids — both present,
 * the sold id absent.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift, seedSoldOutGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Visitor page — legacy multi-row carts only unsold ids', () => {
  test('a cart built from a LEGACY MULTI-ROW gift picks ONLY the unsold contribuição ids', async ({
    page,
    seededData,
  }) => {
    // One unique shared name → the grouper collapses all three rows into
    // a single card keyed by this nome.
    const sharedName = `Mimo Legado E2E ${randomUUID().slice(0, 8)}`;
    const valorCents = 5000;

    // Seed: 1 sold row + 2 available rows, all sharing nome/valor/opção,
    // each quantidade=1 (the legacy multi-row shape).
    const db = createDatabase(DATABASE_URL);
    let soldId: string;
    let unsoldIdA: string;
    let unsoldIdB: string;
    try {
      const repos = buildSeedGiftRepos(db);
      const seedOpts = {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: sharedName,
        valorCents,
        quantidade: 1,
      };
      soldId = await seedSoldOutGift(repos, seedOpts);
      unsoldIdA = await seedAvailableGift(repos, seedOpts);
      unsoldIdB = await seedAvailableGift(repos, seedOpts);
    } finally {
      await db.destroy();
    }

    const expectedUnsold = new Set([unsoldIdA, unsoldIdB]);

    // Anonymous visitor view of the public campaign page.
    await page.goto(`/pagina/${seededData.slug}`);

    // The collapsed card (one card for the shared name) shows 2 of 3
    // available — qtyAvailable=2 (the two unsold rows), qtyTotal=3.
    const card = page.locator('article').filter({ hasText: sharedName });
    await expect(card).toBeVisible();
    await expect(card.getByText(/2 de 3 dispon[ií]veis/i)).toBeVisible();

    // "+ Adicionar" adds 1 unit and opens the cart drawer (Marketplace
    // onAdd → cart.add + drawer.open).
    await card.getByRole('button', { name: /Adicionar/i }).click();

    // Drawer is the dialog labelled "Seu carrinho".
    const drawer = page.getByRole('dialog', { name: /Seu carrinho/i });
    await expect(drawer).toBeVisible();

    // Bump the line quantity to 2 via the drawer's qty stepper
    // (aria-label "Aumentar quantidade de <nome>"; canIncrement = qty <
    // qtyAvailable, so the ceiling is exactly 2). The card's own inline
    // stepper uses "Aumentar <nome>" (no "quantidade de") so this name is
    // unambiguous to the drawer control.
    const incBtn = drawer.getByRole('button', {
      name: `Aumentar quantidade de ${sharedName}`,
    });
    await expect(incBtn).toBeEnabled();
    await incBtn.click();
    // At qty=2 the increment hits the available ceiling and disables.
    await expect(incBtn).toBeDisabled();

    // Intercept the finalize mutation BEFORE clicking. tRPC httpBatchLink
    // POSTs to /api/trpc/pagina.iniciarPagamentoCarrinho (possibly
    // comma-batched) with body { "0": { json: { slug, itens, metodo } } }.
    const reqPromise = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes('/api/trpc/') &&
        req.url().includes('pagina.iniciarPagamentoCarrinho'),
      { timeout: 15_000 },
    );

    await drawer.getByRole('button', { name: /Finalizar compra/i }).click();

    const req = await reqPromise;
    const rawBody = req.postData();
    console.log('[iniciarPagamentoCarrinho] postData:', rawBody);
    expect(rawBody, 'iniciarPagamentoCarrinho should carry a request body').toBeTruthy();

    const parsed = JSON.parse(rawBody as string);
    // httpBatchLink wraps each call as { "<index>": { json: <input> } }.
    // Be liberal: fall through the known unwrappings.
    const input = parsed?.['0']?.json ?? parsed?.json ?? parsed?.['0'] ?? parsed;
    const itens = input?.itens as Array<{ idContribuicao: string; quantidade: number }>;

    expect(Array.isArray(itens), `expected itens[] in input; got ${JSON.stringify(input)}`).toBe(
      true,
    );

    const postedIds = new Set(itens.map((i) => i.idContribuicao));

    // ═══ THE ASSERTIONS THIS TEST EXISTS FOR ═══
    // Both unsold ids present.
    expect(
      postedIds.has(unsoldIdA),
      `unsold id A (${unsoldIdA}) must be in the posted itens; got ${JSON.stringify([...postedIds])}`,
    ).toBe(true);
    expect(
      postedIds.has(unsoldIdB),
      `unsold id B (${unsoldIdB}) must be in the posted itens; got ${JSON.stringify([...postedIds])}`,
    ).toBe(true);

    // Sold id NEVER reaches the saga.
    expect(
      postedIds.has(soldId),
      `sold id (${soldId}) must NOT be in the posted itens; got ${JSON.stringify([...postedIds])}`,
    ).toBe(false);

    // Exactly the two unsold ids — no more, no less.
    expect(postedIds).toEqual(expectedUnsold);
  });
});
