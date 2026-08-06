import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PaymentMoneyMovementMemoryCoordinator } from '../../../src/adapters/pagamentos/payment-money-movement-lock.memory.js';
import { PixCobrancaDevolucaoRepositoryMemory } from '../../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.memory.js';
import type { IdCampanha } from '../../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import type {
  IdItemDoPagamento,
  IdPagamento,
} from '../../../src/domain/pagamentos/value-objects/ids.js';
import { FinanceiroPagamentoMovimentacaoConflitanteError } from '../../../src/errors/pagamentos/financeiro/pagamento-movimentacao-conflitante.error.js';
import { describePixCobrancaDevolucaoRepositoryConformance } from '../../helpers/pix-cobranca-devolucao-repository.conformance.js';

describePixCobrancaDevolucaoRepositoryConformance('Memory', {
  factory: () => new PixCobrancaDevolucaoRepositoryMemory(),
});

describe('PIX charge refund × payout mutual exclusion — Memory', () => {
  function fixture() {
    const coordinator = new PaymentMoneyMovementMemoryCoordinator();
    const livro = new LivroFinanceiroRepositoryMemory(undefined, undefined, coordinator);
    const refunds = new PixCobrancaDevolucaoRepositoryMemory(coordinator);
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
    const input = {
      id: randomUUID(),
      idPagamento: lancamento.idPagamento as IdPagamento,
      e2eId: 'E'.repeat(32),
      idDevolucao: 'D'.repeat(26),
      amountCents: 1_000,
      criadoEm: new Date('2026-08-05T12:01:00Z'),
    };
    return { livro, refunds, lancamento, input };
  }

  it('mirrors both winner orderings using the shared per-payment coordinator', async () => {
    const refundFirst = fixture();
    await refundFirst.livro.saveLancamentos([refundFirst.lancamento]);
    await refundFirst.refunds.createIfAbsent(refundFirst.input);
    await expect(
      refundFirst.livro.marcarLancamentosComoTransferidos(
        [refundFirst.lancamento.id],
        new Date('2026-08-05T12:02:00Z'),
      ),
    ).rejects.toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);

    const transferFirst = fixture();
    await transferFirst.livro.saveLancamentos([transferFirst.lancamento]);
    await transferFirst.livro.marcarLancamentosComoTransferidos(
      [transferFirst.lancamento.id],
      new Date('2026-08-05T12:02:00Z'),
    );
    await expect(transferFirst.refunds.createIfAbsent(transferFirst.input)).rejects.toBeInstanceOf(
      FinanceiroPagamentoMovimentacaoConflitanteError,
    );
  });

  it('blocks manual approval and the fresh automatic PIX claim when a refund marker exists', async () => {
    for (const path of ['manual', 'automatic'] as const) {
      const state = fixture();
      const idRepasse = randomUUID() as IdRepasse;
      const linkedLancamento = { ...state.lancamento, idRepasse };
      await state.livro.saveLancamentos([linkedLancamento]);
      await state.refunds.createIfAbsent(state.input);

      const repasse: RepasseRecebedor = {
        id: idRepasse,
        idCampanha: linkedLancamento.idCampanha as IdCampanha,
        amountCents: linkedLancamento.amountCents,
        status: path === 'manual' ? 'solicitado' : 'aprovado',
        solicitadoEm: new Date('2026-08-05T11:00:00Z'),
        aprovadoEm: path === 'manual' ? null : new Date('2026-08-05T11:30:00Z'),
        bankTransferRef: null,
        transferReferencia: path === 'manual' ? null : 'repasse-stable-reference',
        interCodigoSolicitacao: null,
        transferAttempts: 0,
        lastTransferError: null,
        needsManualResolution: false,
      };
      await state.livro.saveRepasse(repasse);

      const operation =
        path === 'manual'
          ? state.livro.aprovarRepasseTransaction({
              idRepasse,
              aprovadoEm: new Date('2026-08-05T12:02:00Z'),
              bankTransferRef: 'manual-ref',
            })
          : state.livro.iniciarTransferenciaTransaction({
              idRepasse,
              requestSummary: 'pix-transfer',
              agora: new Date('2026-08-05T12:02:00Z'),
            });
      await expect(operation).rejects.toBeInstanceOf(
        FinanceiroPagamentoMovimentacaoConflitanteError,
      );
      expect((await state.livro.findRepasseById(idRepasse))?.status).toBe(repasse.status);
      expect(
        (await state.livro.findLancamentosByIds([linkedLancamento.id]))[0]?.transferidoEm,
      ).toBeNull();
    }
  });
});
