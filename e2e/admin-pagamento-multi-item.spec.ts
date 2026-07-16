/**
 * Admin pagamento detail — multi-item Pagamentos card (aperture-8ro9v Phase 12).
 *
 * The /admin/pagamento/:idPagamento detail page (AdminPagamentoPage.tsx) reads
 * `admin.pagamentos.findById` and renders the shared PagamentoCard. When the
 * pagamento carries MULTIPLE contribuição items, the card's ItensList renders
 * one ItemContribuicaoRow per item — each showing the contribuição name, and a
 * `× N` quantidade chip for items with quantidade > 1.
 *
 * Admin routes are gated by the AdminShell UX auth gate (aperture-r5fg0):
 * a non-admin visitor is bounced to the landing page. This uses the
 * `adminAuthenticatedPage` fixture (allowlisted admin session) so the real
 * pagamento chrome renders. The backend `adminProcedure` (aperture-4n222) is
 * the real security boundary.
 *
 * Seeds via the seedMultiItemApprovedPagamento helper (NEW/UNPROVEN). If the
 * seed throws, the test fails with the helper's error + stack — we do NOT work
 * around it.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedMultiItemApprovedPagamento } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

test.describe('Admin pagamento detail — multi-item card', () => {
  test('renders the multi-item PagamentoCard with each contribuição item row', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const nomeA = `Item Multi A ${suffix}`;
    const nomeB = `Item Multi B ${suffix}`;

    // Seed ONE approved pagamento carrying two contribuição items.
    const db = createDatabase(DATABASE_URL);
    let pagamentoId: string;
    try {
      const repos = buildSeedGiftRepos(db);
      const result = await seedMultiItemApprovedPagamento(repos, {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        items: [
          { nome: nomeA, valorCents: 5000, quantidade: 2 },
          { nome: nomeB, valorCents: 3000, quantidade: 1 },
        ],
      });
      pagamentoId = result.pagamentoId;
    } finally {
      await db.destroy();
    }

    // Admin view of the pagamento detail page (allowlisted admin session).
    await page.goto(`/admin/pagamento/${pagamentoId}`);

    // The PagamentoCard renders inside an <article>.
    const card = page.locator('article').first();
    await expect(card).toBeVisible();

    // Both item rows are present — assert both contribuição names are visible.
    await expect(page.getByText(nomeA, { exact: true })).toBeVisible();
    await expect(page.getByText(nomeB, { exact: true })).toBeVisible();

    // Multi-item structure: item A (quantidade 2) shows the "× 2" chip.
    // The chip renders as `× <span>2</span>` → combined text "× 2".
    await expect(card.getByText(/×\s*2/).first()).toBeVisible();
  });
});
