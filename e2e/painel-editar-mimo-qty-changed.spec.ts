/**
 * Painel Editar mimo — qty-CHANGED saveEdit (aperture-8ro9v, E2E Phase 1.2 #1).
 *
 * SIBLING of painel-editar-mimo.spec.ts (which locks the qty-UNCHANGED path).
 * That test's header notes the qty-CHANGED counterpart lands "once Vance's
 * qty-changed fix lands; tracked as a sibling under aperture-ilji3" — this is
 * that sibling.
 *
 * THE INVARIANT (Plan 0016)
 * ─────────────────────────
 * After Plan 0016, saveEdit is FULLY ATOMIC for ALL edits, INCLUDING quantity
 * changes. The legacy delete+createBulk path was retired from saveEdit. So
 * when the user edits a gift and CHANGES the quantity:
 *   - EXACTLY ONE tRPC `contribuicao.update` request fires
 *   - ZERO tRPC `contribuicao.delete` requests fire
 *   - ZERO tRPC `contribuicao.createBulk` requests fire
 *   - The contribuição id is preserved across the edit (critical for the
 *     intencao_items.idContribuicao FK)
 *
 * The delete+createBulk shape on a qty change is the pre-0016 regression this
 * guards against.
 */
import { expect, test } from './fixtures.js';

test.describe('Painel — Editar mimo saveEdit (qty CHANGED)', () => {
  test('qty CHANGED save fires exactly one contribuicao.update, zero delete, zero createBulk (Plan 0016 atomic edit)', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // Tally tRPC mutation procedure names that fire during saveEdit.
    // httpBatchLink may comma-join batched procedures in the path.
    const trpcCalls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      const m = url.match(/\/api\/trpc\/([^?]+)/);
      if (m?.[1] && req.method() === 'POST') {
        for (const procedure of m[1].split(',')) {
          trpcCalls.push(procedure);
        }
      }
    });

    await page.goto(`/painel/${seededData.slug}/lista`);

    // Wait for the seeded contribuição card to hydrate.
    await expect(page.getByTestId('lista-card').first()).toBeVisible();
    await expect(page.getByText(seededData.nomeContribuicao)).toBeVisible();

    // Open the edit modal for the seeded gift.
    const editButton = page.getByRole('button', {
      name: `Editar ${seededData.nomeContribuicao}`,
    });
    await expect(editButton).toBeVisible();
    await editButton.click();

    // Wait for the qty input so we're past the form-mount race.
    const qtyInput = page.getByTestId('qty-input');
    await expect(qtyInput).toBeVisible();
    const originalQty = Number(await qtyInput.inputValue()) || 1;
    const newQty = originalQty + 1;

    // CHANGE the quantity — this is the path under test (qty-UNCHANGED is the
    // sibling spec). Fill triggers the controlled input's onChange.
    await qtyInput.fill(String(newQty));
    await expect(qtyInput).toHaveValue(String(newQty));

    // Wait specifically for the update response, then settle for any
    // post-save batched requests.
    const updateResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/trpc/contribuicao.update') && resp.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByTestId('edit-save-btn').click();

    const updateResponse = await updateResponsePromise;
    expect(updateResponse.status(), 'contribuicao.update should return 2xx').toBeLessThan(300);

    await page.waitForTimeout(500);

    // ═══ THE ASSERTIONS ═══
    const updateCalls = trpcCalls.filter((p) => p.includes('contribuicao.update'));
    const deleteCalls = trpcCalls.filter((p) => p.includes('contribuicao.delete'));
    const createBulkCalls = trpcCalls.filter((p) => p.includes('contribuicao.createBulk'));

    expect(
      updateCalls.length,
      `Expected exactly 1 contribuicao.update on a qty change; got ${updateCalls.length}. Calls: ${JSON.stringify(trpcCalls)}`,
    ).toBe(1);

    expect(
      deleteCalls.length,
      `qty-CHANGED save MUST NOT call contribuicao.delete (pre-0016 regression). Got ${deleteCalls.length}. Calls: ${JSON.stringify(trpcCalls)}`,
    ).toBe(0);

    expect(
      createBulkCalls.length,
      `qty-CHANGED save MUST NOT call contribuicao.createBulk (pre-0016 regression). Got ${createBulkCalls.length}. Calls: ${JSON.stringify(trpcCalls)}`,
    ).toBe(0);
  });
});
