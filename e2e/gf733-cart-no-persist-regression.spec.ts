/**
 * REGRESSION LOCK — aperture-gf733 / bug B (aperture-90rab).
 *
 * BUG (shipped to prod, fixed in c9b2d7a without a locking test):
 *   The guest marketplace cart (pages/lib/cart.tsx) persisted its state to
 *   localStorage under a key derived from the page/USER slug
 *   (`eunenem.cart.v1.<slug>`) and rehydrated from it on every mount. Because
 *   two campanhas of the same account resolved to the SAME slug bucket, gifts
 *   added while viewing campaign A reappeared in campaign B's cart — a
 *   cross-campanha leak. It also meant a plain page reload rehydrated a stale
 *   cart.
 *
 * FIX (c9b2d7a, operator decision): the cart is IN-MEMORY ONLY. No hydrate,
 *   no persist — CartProvider holds state in a useReducer that lives and dies
 *   with the page mount. No shared bucket ⇒ no leak, by construction.
 *
 * INVARIANT LOCKED HERE:
 *   1. Adding a gift writes ZERO `eunenem.cart.*` localStorage keys.
 *   2. A page reload starts with an EMPTY cart (nothing to rehydrate).
 *
 * HOW THIS CATCHES A REGRESSION (proven against the pre-fix behaviour):
 *   - Pre-fix, the "persist on every state change" effect wrote
 *     `eunenem.cart.v1.<slug>` the moment an item was added → assertion (1)
 *     would find the key and FAIL.
 *   - Pre-fix, the "hydrate on mount" effect re-read that bucket after reload,
 *     so the CartButton (hidden only when totalUnits===0) would still render
 *     with the item → assertion (2) would find the cart non-empty and FAIL.
 *   Both assertions therefore lock the persistence removal, not a vacuous pass.
 *
 * The reload leg is the faithful reproduction of the cross-campanha leak on a
 * single seeded slug: under the old code a fresh mount on the same slug
 * rehydrated the persisted bucket (exactly what let campanha B inherit
 * campanha A's cart). In-memory-only makes that impossible.
 *
 * RUN LOCALLY:
 *   docker compose -f docker/docker-compose.yml up -d
 *   pnpm test:e2e e2e/gf733-cart-no-persist-regression.spec.ts
 */
import { expect, test } from './fixtures.js';

test.describe('aperture-gf733 / 90rab — guest cart does NOT persist across mounts', () => {
  test('adding a gift writes no eunenem.cart.* keys and the cart is empty after reload', async ({
    page,
    seededData,
  }) => {
    const giftName = seededData.nomeContribuicao;

    // Anonymous visitor view of the public campaign page.
    await page.goto(`/pagina/${seededData.slug}`);

    const card = page.locator('article').filter({ hasText: giftName });
    await expect(card).toBeVisible();

    // Add 1 unit. CartButton renders only when totalUnits > 0, so its
    // presence + count is the observable cart state.
    await card.getByRole('button', { name: /\+ Adicionar/i }).click();

    const cartButton = page.getByRole('button', { name: /Abrir carrinho — 1 item/i });
    await expect(
      cartButton,
      'cart must hold the added gift before we check persistence',
    ).toBeVisible();

    // ── LOCK 1: zero eunenem.cart.* localStorage keys after the add ────────
    // Pre-fix this bucket (`eunenem.cart.v1.<slug>`) was written on every
    // state change → this array would be non-empty.
    const cartKeys = await page.evaluate(() =>
      Object.keys(window.localStorage).filter((k) => k.startsWith('eunenem.cart')),
    );
    expect(
      cartKeys,
      'guest cart must NOT persist — no eunenem.cart.* localStorage keys may exist after an add ' +
        '(re-introducing persistence keyed by slug is the aperture-90rab cross-campanha leak)',
    ).toEqual([]);

    // ── LOCK 2: reload starts with an EMPTY cart (no rehydration) ──────────
    // Pre-fix the mount-time hydrate effect re-read the persisted bucket, so
    // the CartButton would still render post-reload. In-memory-only ⇒ gone.
    await page.reload();
    await expect(card).toBeVisible(); // page is back up
    await expect(
      page.getByRole('button', { name: /Abrir carrinho/i }),
      'after reload the cart must be EMPTY — a surviving cart proves localStorage rehydration ' +
        'came back (the persisted bucket that leaked across campanhas)',
    ).toHaveCount(0);
  });
});
