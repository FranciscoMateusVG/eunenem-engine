/**
 * Painel Editar mimo — saveEdit regression test (aperture-ilji3, child of
 * the E2E gate epic).
 *
 * THE REGRESSION THIS LOCKS DOWN
 * ──────────────────────────────
 * 2026-06-08 night: operator caught Phase 4 ListaPresentesBody saveEdit
 * firing `contribuicao.delete` instead of `contribuicao.update` on the
 * qty-unchanged save path. Vance fixed it in commit 7b0dc7a; this test
 * encodes the fix as a regression check.
 *
 * THE INVARIANT
 * ─────────────
 * When the user clicks "Editar" on a gift card, modifies only the nome
 * (quantidade unchanged), and clicks "Salvar alterações":
 *   - EXACTLY ONE tRPC `contribuicao.update` request fires
 *   - ZERO tRPC `contribuicao.delete` requests fire
 *   - ZERO tRPC `contribuicao.createBulk` requests fire
 *   - The page returns to a stable post-save state (modal closed)
 *
 * Any other shape is the regression operator caught. The delete+createBulk
 * legacy path stays exclusive to qty-changed saves (covered in a separate
 * test once Vance's qty-changed fix lands; tracked as a sibling under
 * aperture-ilji3).
 */
import { expect, test } from './fixtures.js';

test.describe('Painel — Editar mimo saveEdit', () => {
  test('qty UNCHANGED save fires exactly one contribuicao.update, zero contribuicao.delete (locks down 2026-06-08 regression)', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // Collect tRPC mutation URLs that fire during the saveEdit action.
    // tRPC httpBatchLink may batch calls into a comma-joined path
    // (e.g. /api/trpc/contribuicao.update,foo) — match the procedure
    // name as a substring.
    const trpcCalls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      const m = url.match(/\/api\/trpc\/([^?]+)/);
      if (m && m[1] && req.method() === 'POST') {
        // httpBatchLink encodes batched procedures comma-separated.
        for (const procedure of m[1].split(',')) {
          trpcCalls.push(procedure);
        }
      }
    });

    await page.goto(`/painel/${seededData.slug}/lista`);

    // Wait for the painel to hydrate + render the seeded contribuição
    // card. The card carries `data-testid="lista-card"` and includes the
    // gift name as visible text.
    await expect(page.getByTestId('lista-card').first()).toBeVisible();
    await expect(page.getByText(seededData.nomeContribuicao)).toBeVisible();

    // Open the edit modal. The Edit button is keyed by gift name via
    // aria-label; we pick the one matching our seeded contribuição.
    const editButton = page.getByRole('button', {
      name: `Editar ${seededData.nomeContribuicao}`,
    });
    await expect(editButton).toBeVisible();
    await editButton.click();

    // The modal renders with the gift fields prefilled. Wait for the
    // qty input (data-testid="qty-input") so we know we're past the
    // form-mount race.
    const qtyInput = page.getByTestId('qty-input');
    await expect(qtyInput).toBeVisible();
    const originalQty = await qtyInput.inputValue();

    // Modify ONLY the nome — qty must stay identical to trigger the
    // qty-unchanged code path. The nome field uses an aria-label.
    const nomeField = page.getByLabel('nome do presente', { exact: false });
    await expect(nomeField).toBeVisible();
    const newName = `${seededData.nomeContribuicao} — edited`;
    await nomeField.fill(newName);

    // Sanity check: qty is unchanged before save.
    await expect(qtyInput).toHaveValue(originalQty);

    // Click save and wait for the network response. We listen for the
    // tRPC update response specifically — that's the one the test
    // asserts on; any failure path (404, 500) bubbles up as a non-2xx
    // and the expect below catches it.
    const updateResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/trpc/contribuicao.update') && resp.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByTestId('edit-save-btn').click();

    const updateResponse = await updateResponsePromise;
    expect(updateResponse.status(), 'contribuicao.update should return 2xx').toBeLessThan(300);

    // Settle a beat so the modal close + any post-save batched requests
    // land before we tally trpcCalls.
    await page.waitForTimeout(500);

    // ═══ THE ASSERTIONS THIS TEST EXISTS FOR ═══
    const updateCalls = trpcCalls.filter((p) => p.includes('contribuicao.update'));
    const deleteCalls = trpcCalls.filter((p) => p.includes('contribuicao.delete'));
    const createBulkCalls = trpcCalls.filter((p) => p.includes('contribuicao.createBulk'));

    expect(
      updateCalls.length,
      `Expected exactly 1 contribuicao.update call; got ${updateCalls.length}. Full call log: ${JSON.stringify(trpcCalls)}`,
    ).toBe(1);

    expect(
      deleteCalls.length,
      `qty-unchanged save MUST NOT call contribuicao.delete (the 2026-06-08 regression). Got ${deleteCalls.length} delete calls. Full call log: ${JSON.stringify(trpcCalls)}`,
    ).toBe(0);

    expect(
      createBulkCalls.length,
      `qty-unchanged save MUST NOT call contribuicao.createBulk. Got ${createBulkCalls.length} createBulk calls. Full call log: ${JSON.stringify(trpcCalls)}`,
    ).toBe(0);
  });
});
