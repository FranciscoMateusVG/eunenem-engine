import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PixCobrancaDevolucaoRepositoryPostgres } from '../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
} from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import type {
  IdItemDoPagamento,
  IdPagamento,
} from '../../src/domain/pagamentos/value-objects/ids.js';
import { FinanceiroPagamentoMovimentacaoConflitanteError } from '../../src/errors/pagamentos/financeiro/pagamento-movimentacao-conflitante.error.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { describePixCobrancaDevolucaoRepositoryConformance } from '../helpers/pix-cobranca-devolucao-repository.conformance.js';
import { withLancamentoSeeding } from '../helpers/seed-lancamento-parents.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

let testDb: TestDatabase;
const seededPagamentoIds = new Set<IdPagamento>();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describePixCobrancaDevolucaoRepositoryConformance('Postgres', {
  factory: () => new PixCobrancaDevolucaoRepositoryPostgres(testDb.db),
  resetState: async () => {
    await truncatePagamentosTables(testDb.db);
    seededPagamentoIds.clear();
  },
  preparePagamento: async (idPagamento) => {
    if (seededPagamentoIds.has(idPagamento)) return;
    const pagamento = makePagamento({ id: idPagamento });
    await seedPagamentoParents(testDb.db, pagamento);
    await new PagamentoRepositoryPostgres(testDb.db).save(pagamento);
    seededPagamentoIds.add(idPagamento);
  },
});

describe('PIX charge refund × payout mutual exclusion — Postgres', () => {
  let refundRepo: PixCobrancaDevolucaoRepositoryPostgres;
  let livroRepo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    await truncatePagamentosTables(testDb.db);
    refundRepo = new PixCobrancaDevolucaoRepositoryPostgres(testDb.db);
    livroRepo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);
  });

  async function seedLancamento(): Promise<LancamentoFinanceiro> {
    const lancamento: LancamentoFinanceiro = {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento: randomUUID() as IdPagamentoReferencia,
      idItemPagamento: randomUUID() as IdItemDoPagamento,
      idContribuicao: randomUUID() as IdContribuicaoReferencia,
      idCampanha: randomUUID() as IdCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 1_000,
      criadoEm: new Date('2026-08-05T12:00:00Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
    };
    await livroRepo.saveLancamentos([lancamento]);
    // biome-ignore lint/suspicious/noExplicitAny: fixture update outside the BC-scoped DB type
    await (testDb.db as any)
      .updateTable('pagamentos')
      .set({ intencao_balance_transaction_available_on: new Date('2026-08-04T12:00:00Z') })
      .where('id', '=', lancamento.idPagamento)
      .execute();
    return lancamento;
  }

  function refundInput(idPagamento: IdPagamento) {
    return {
      id: randomUUID(),
      idPagamento,
      e2eId: 'E'.repeat(32),
      idDevolucao: 'D'.repeat(26),
      amountCents: 1_000,
      criadoEm: new Date('2026-08-05T12:01:00Z'),
    };
  }

  it('refund marker wins first: transfer stamp is rejected and eligible scan excludes the row', async () => {
    const lancamento = await seedLancamento();
    await refundRepo.createIfAbsent(refundInput(lancamento.idPagamento as IdPagamento));

    await expect(
      livroRepo.marcarLancamentosComoTransferidos(
        [lancamento.id],
        new Date('2026-08-05T12:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
    await expect(
      livroRepo.findLancamentosDisponiveisByIdCampanha(
        lancamento.idCampanha as IdCampanha,
        new Date('2026-08-05T12:02:00Z'),
      ),
    ).resolves.toEqual([]);
    expect((await livroRepo.findLancamentosByIds([lancamento.id]))[0]?.transferidoEm).toBeNull();
  });

  it('transfer stamp wins first: refund marker is rejected', async () => {
    const lancamento = await seedLancamento();
    await livroRepo.marcarLancamentosComoTransferidos(
      [lancamento.id],
      new Date('2026-08-05T12:02:00Z'),
    );

    await expect(
      refundRepo.createIfAbsent(refundInput(lancamento.idPagamento as IdPagamento)),
    ).rejects.toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
    await expect(
      refundRepo.findByPagamentoId(lancamento.idPagamento as IdPagamento),
    ).resolves.toBeUndefined();
  });

  it('simultaneous first claims serialize: exactly one irreversible direction wins', async () => {
    const lancamento = await seedLancamento();
    const [refund, transfer] = await Promise.allSettled([
      refundRepo.createIfAbsent(refundInput(lancamento.idPagamento as IdPagamento)),
      livroRepo.marcarLancamentosComoTransferidos(
        [lancamento.id],
        new Date('2026-08-05T12:02:00Z'),
      ),
    ]);

    expect([refund.status, transfer.status].sort()).toEqual(['fulfilled', 'rejected']);
    const storedRefund = await refundRepo.findByPagamentoId(lancamento.idPagamento as IdPagamento);
    const storedLancamento = (await livroRepo.findLancamentosByIds([lancamento.id]))[0];
    expect((storedRefund !== undefined) !== (storedLancamento?.transferidoEm !== null)).toBe(true);
  });
});
