import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { PagamentoRepositoryPostgres } from '../src/adapters/pagamentos/repository.postgres.js';
import { criarItemContribuicao } from '../src/domain/pagamentos/entities/item-do-pagamento.js';
import { criarPagamentoPendente } from '../src/domain/pagamentos/entities/pagamento.js';
import { expect, test } from './fixtures.js';

// Synthetic payment rows only, on the existing isolated local runner.
test.beforeEach(() => {
  test.skip(!process.env.E2E_9BPRE_CONTAINER, 'Requires ephemeral database runner');
});

for (const surface of ['pagina', 'painel'] as const) {
  test(`${surface}: remove gift with pending/rejected attempts, preserve history`, async ({
    authenticatedPage: page,
    seededData,
  }) => {
    const uri = process.env.E2E_DATABASE_URL;
    if (!uri) throw new Error('Missing isolated database URI');
    const db = createDatabase(uri);
    try {
      const repo = new PagamentoRepositoryPostgres(db);
      const payments = (['pendente', 'rejeitado'] as const).map((status) => ({
        ...criarPagamentoPendente({
          idPagamento: randomUUID(),
          idIntencaoPagamento: randomUUID(),
          metodo: 'pix',
          criadoEm: new Date(),
          valorACobrarCents: 1100,
          items: [
            criarItemContribuicao({
              id: randomUUID(),
              criadoEm: new Date(),
              composicaoValoresItem: {
                tipo: 'contribuicao',
                idContribuicao: seededData.idContribuicao,
                quantidade: 1,
                contributionUnitAmountCents: 1000,
                feeUnitAmountCents: 100,
                receiverUnitAmountCents: 1000,
                lineContributionAmountCents: 1000,
                lineFeeAmountCents: 100,
                lineReceiverAmountCents: 1000,
              },
            }),
          ],
          composicaoValoresAggregate: {
            idCampanha: seededData.idCampanha,
            totalContributionCents: 1000,
            totalFeeCents: 100,
            totalReceiverCents: 1000,
            totalSurchargeCents: 0,
            totalPaidCents: 1100,
            responsavelTaxa: 'contribuinte',
          },
        }),
        status,
      }));
      for (const payment of payments) await repo.save(payment);
      const before = await Promise.all(payments.map((p) => repo.findById(p.id)));
      await page.goto(
        surface === 'pagina' ? `/pagina/${seededData.slug}` : `/painel/${seededData.slug}/lista`,
      );
      await page
        .getByRole('button', { name: `Remover ${seededData.nomeContribuicao}`, exact: true })
        .click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Remover este presente' });
      await dialog.getByRole('button', { name: 'Sim, remover' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: `Remover ${seededData.nomeContribuicao}`, exact: true }),
      ).toHaveCount(0);
      await page.goto(`/pagina/${seededData.slug}`);
      await expect(
        page.locator(`article[data-gift-nome="${seededData.nomeContribuicao}"]`),
      ).toHaveCount(0);
      await page.goto(`/painel/${seededData.slug}/lista`);
      await expect(
        page.getByRole('button', { name: `Remover ${seededData.nomeContribuicao}`, exact: true }),
      ).toHaveCount(0);
      expect(await Promise.all(payments.map((p) => repo.findById(p.id)))).toEqual(before);
      const gift = await db
        .selectFrom('contribuicoes')
        .select('arquivada_em')
        .where('id', '=', seededData.idContribuicao)
        .executeTakeFirstOrThrow();
      expect(gift.arquivada_em).not.toBeNull();
    } finally {
      await db.destroy();
    }
  });
}
