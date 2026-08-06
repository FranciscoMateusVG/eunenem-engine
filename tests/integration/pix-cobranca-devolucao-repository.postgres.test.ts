import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PixCobrancaDevolucaoRepositoryPostgres } from '../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
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
  await resetMutualExclusionState();
  await testDb.teardown();
});

async function resetMutualExclusionState(): Promise<void> {
  // Keep this file isolated from the shared integration database. The fresh
  // payout claim owns attempt/ledger rows that must be removed before its
  // repasse and payment parents.
  // biome-ignore lint/suspicious/noExplicitAny: finance tables outside the generated BC type
  const db = testDb.db as any;
  await db.deleteFrom('repasse_reconciliacao_candidatos').execute();
  await db.deleteFrom('repasse_transfer_attempts').execute();
  await db.deleteFrom('lancamentos_financeiros').execute();
  await db.deleteFrom('repasses_recebedor').execute();
  await truncatePagamentosTables(testDb.db);
}

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
    await resetMutualExclusionState();
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

  async function seedApprovedPixRepasse(): Promise<{
    readonly lancamento: LancamentoFinanceiro;
    readonly idRepasse: IdRepasse;
  }> {
    const idRepasse = randomUUID() as IdRepasse;
    const idCampanha = randomUUID() as IdCampanha;
    const repasse: RepasseRecebedor = {
      id: idRepasse,
      idCampanha,
      amountCents: 1_000,
      status: 'aprovado',
      solicitadoEm: new Date('2026-08-05T11:00:00Z'),
      aprovadoEm: new Date('2026-08-05T11:30:00Z'),
      bankTransferRef: null,
      transferReferencia: `EN${String(idRepasse).replaceAll('-', '')}`,
      interCodigoSolicitacao: null,
      transferAttempts: 0,
      lastTransferError: null,
      needsManualResolution: false,
    };
    const lancamento: LancamentoFinanceiro = {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento: randomUUID() as IdPagamentoReferencia,
      idItemPagamento: randomUUID() as IdItemDoPagamento,
      idContribuicao: randomUUID() as IdContribuicaoReferencia,
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 1_000,
      criadoEm: new Date('2026-08-05T12:00:00Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse,
    };
    await livroRepo.saveRepasse(repasse);
    // withLancamentoSeeding creates the same approved payment referenced by
    // the refund operation and by this repasse's payout claim.
    await livroRepo.saveLancamentos([lancamento]);
    return { lancamento, idRepasse };
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

  it('serializes a real fresh PIX payout claim against refund creation for the same payment', async () => {
    const { lancamento, idRepasse } = await seedApprovedPixRepasse();
    const [refund, payout] = await Promise.allSettled([
      refundRepo.createIfAbsent(refundInput(lancamento.idPagamento as IdPagamento)),
      livroRepo.iniciarTransferenciaTransaction({
        idRepasse,
        requestSummary: 'pagarPix valor=1000',
        agora: new Date('2026-08-05T12:02:00Z'),
      }),
    ]);

    expect([refund.status, payout.status].sort()).toEqual(['fulfilled', 'rejected']);
    const storedRefund = await refundRepo.findByPagamentoId(lancamento.idPagamento as IdPagamento);
    const storedRepasse = await livroRepo.findRepasseById(idRepasse);
    const attempts = await livroRepo.findTransferAttemptsByRepasseId(idRepasse);

    if (refund.status === 'fulfilled') {
      expect(payout.status).toBe('rejected');
      if (payout.status !== 'rejected') throw new Error('payout unexpectedly fulfilled');
      expect(payout.reason).toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
      expect(storedRefund).toBeDefined();
      expect(storedRepasse?.status).toBe('aprovado');
      expect(attempts).toEqual([]);
      return;
    }

    expect(payout.status).toBe('fulfilled');
    if (payout.status !== 'fulfilled') throw new Error('payout unexpectedly rejected');
    expect(refund.reason).toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
    expect(payout.value.acao).toBe('prosseguir');
    expect(storedRefund).toBeUndefined();
    expect(storedRepasse?.status).toBe('transferindo');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptNo).toBe(1);
  });
});
