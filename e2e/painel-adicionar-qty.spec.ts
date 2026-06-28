/**
 * Painel Adicionar mimo — quantidade single-row model (aperture-8ro9v, E2E Phase 1.2 #2).
 *
 * THE INVARIANT (Plan 0016 — "ONE row, not N rows")
 * ──────────────────────────────────────────────────
 * Pre-0016, adding a custom gift with quantidade=N fanned out into N
 * contribuicao rows. Plan 0016 lifts cardinality onto the slot: one
 * contribuicao row carries `quantidade=N`. So when the owner opens the
 * "Personalizado" add form, sets quantidade=N, and submits:
 *   - EXACTLY ONE tRPC `contribuicao.create` request fires (NOT createBulk)
 *   - ZERO tRPC `contribuicao.createBulk` requests fire
 *   - The DB holds EXACTLY ONE row for that gift name, with quantidade === N
 *
 * The N-rows shape is the pre-0016 regression this guards against. The DB
 * assertion is load-bearing: the UI could group N rows back into one card,
 * so we go to the data layer to prove there's a single row.
 */
import { randomUUID } from 'node:crypto';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';

// Mirror fixtures.ts DATABASE_URL resolution exactly so the DB read targets
// the same Postgres the seed + server use.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Painel — Adicionar mimo (quantidade single-row)', () => {
  test('Adicionar personalizado with quantidade=N creates ONE contribuicao row carrying quantidade=N, not N rows', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    const N = 3;
    // Unique name so we can distinguish the NEW gift from the pre-seeded
    // "Fralda Premium …" contribuição when we query the DB.
    const newGiftName = `Cadeirinha E2E ${randomUUID().slice(0, 8)}`;

    // Tally tRPC mutation procedure names that fire during the add.
    // httpBatchLink may comma-join batched procedures in the path.
    const trpcCalls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      const m = url.match(/\/api\/trpc\/([^?]+)/);
      if (m && m[1] && req.method() === 'POST') {
        for (const procedure of m[1].split(',')) {
          trpcCalls.push(procedure);
        }
      }
    });

    await page.goto(`/painel/${seededData.slug}/lista`);

    // Wait for the painel to hydrate (the seeded gift card proves the list
    // query resolved).
    await expect(page.getByTestId('lista-card').first()).toBeVisible();
    await expect(page.getByText(seededData.nomeContribuicao)).toBeVisible();

    // Open the Add modal straight onto the Personalizado tab.
    await page.getByRole('button', { name: 'Criar item personalizado' }).click();

    // The Personalizado form mounts inside the dialog. Wait for the qty input
    // (data-testid="qty-input") so we're past the form-mount race.
    const qtyInput = page.getByTestId('qty-input');
    await expect(qtyInput).toBeVisible();

    // Nome — reached via its label "nome do mimo" (case-insensitive substring).
    const nomeField = page.getByLabel('Nome do mimo', { exact: false });
    await expect(nomeField).toBeVisible();
    await nomeField.fill(newGiftName);

    // Valor — required (>0) for the submit button to enable. Reached via its
    // label "valor por unidade".
    const priceField = page.getByLabel('valor por unidade', { exact: false });
    await priceField.fill('50,00');

    // Set quantidade = N. Fill triggers the controlled input's onChange.
    await qtyInput.fill(String(N));
    await expect(qtyInput).toHaveValue(String(N));

    // Submit. Wait specifically for the create response so we don't tally
    // before the round-trip lands.
    const createResponsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/trpc/contribuicao.create') && resp.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: 'Adicionar à lista' }).click();

    const createResponse = await createResponsePromise;
    expect(createResponse.status(), 'contribuicao.create should return 2xx').toBeLessThan(300);

    // Settle for any post-save batched requests before tallying.
    await page.waitForTimeout(500);

    // ═══ ASSERTION 1 — UI layer ═══
    const createCalls = trpcCalls.filter(
      (p) => p.includes('contribuicao.create') && !p.includes('createBulk'),
    );
    const createBulkCalls = trpcCalls.filter((p) => p.includes('contribuicao.createBulk'));

    expect(
      createCalls.length,
      `Expected exactly 1 contribuicao.create; got ${createCalls.length}. Calls: ${JSON.stringify(trpcCalls)}`,
    ).toBe(1);

    expect(
      createBulkCalls.length,
      `Personalizado add MUST NOT call contribuicao.createBulk (pre-0016 N-row regression). Got ${createBulkCalls.length}. Calls: ${JSON.stringify(trpcCalls)}`,
    ).toBe(0);

    // ═══ ASSERTION 2 — DATA layer (load-bearing: "ONE row, not N rows") ═══
    const db = createDatabase(DATABASE_URL);
    try {
      const repo = new ContribuicaoRepositoryPostgres(db);
      const rows = await repo.findByCampanhaId(seededData.idCampanha);
      const matching = rows.filter((r) => r.nome === newGiftName);

      expect(
        matching.length,
        `Expected EXACTLY ONE contribuicao row for "${newGiftName}" (single-row-with-quantidade model), got ${matching.length}. This is the "ONE row not N rows" invariant.`,
      ).toBe(1);

      expect(matching[0]?.quantidade, `The single row must carry quantidade=${N}.`).toBe(N);
    } finally {
      await db.destroy();
    }
  });
});
