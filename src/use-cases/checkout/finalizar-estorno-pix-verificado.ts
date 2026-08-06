import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../adapters/pagamentos/financeiro/livro-repository.js';
import {
  type PixCobrancaDevolucaoRecord,
  type PixCobrancaDevolucaoRepository,
  PixCobrancaE2eIdSchema,
  PixCobrancaIdDevolucaoSchema,
} from '../../adapters/pagamentos/pix-cobranca-devolucao-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  estornarPagamentoAprovado,
  type Pagamento,
} from '../../domain/pagamentos/entities/pagamento.js';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import {
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoPixVinculoInvalidoError,
} from './estorno-pagamento-errors.js';

const FinalizarEstornoPixVerificadoInputSchema = z.object({
  e2eId: PixCobrancaE2eIdSchema,
  idDevolucao: PixCobrancaIdDevolucaoSchema,
});

export type FinalizarEstornoPixVerificadoInput = z.infer<
  typeof FinalizarEstornoPixVerificadoInputSchema
>;

export interface FinalizarEstornoPixVerificadoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pixCobrancaDevolucaoRepository: PixCobrancaDevolucaoRepository;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
}

export interface FinalizarEstornoPixVerificadoResult {
  readonly pagamentoId: IdPagamento;
}

/**
 * Applies an authoritative Banco Inter refund fact without contacting Inter.
 *
 * A webhook reaches this seam only after verifying the provider state through
 * the read API. Reusing the admin orchestration here would issue a second PUT,
 * so this function intentionally has no provider dependency at all.
 */
export async function finalizarEstornoPixVerificado(
  deps: FinalizarEstornoPixVerificadoDeps,
  input: FinalizarEstornoPixVerificadoInput,
): Promise<FinalizarEstornoPixVerificadoResult> {
  const parsed = FinalizarEstornoPixVerificadoInputSchema.parse(input);
  const devolucao = await deps.pixCobrancaDevolucaoRepository.findByIdentity(
    parsed.e2eId,
    parsed.idDevolucao,
  );
  if (!devolucao) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  const pagamento = await deps.pagamentoRepository.findByE2eExternalRef(parsed.e2eId);
  if (!pagamento || !bindingMatches(devolucao, pagamento)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  const updated = await deps.pixCobrancaDevolucaoRepository.updateOutcome({
    e2eId: parsed.e2eId,
    idDevolucao: parsed.idDevolucao,
    status: 'devolvida',
    atualizadoEm: deps.clock(),
  });
  if (!updated || updated.status !== 'devolvida' || !bindingMatches(updated, pagamento)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  if (pagamento.status === 'estornado') {
    // Crash recovery: the payment CAS may have won before the ledger cascade
    // failed. This repository operation is idempotent, so an exact replay
    // repairs that split state without touching the provider.
    await deps.livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento(
      pagamento.id,
      deps.clock(),
    );
    return { pagamentoId: pagamento.id };
  }
  if (pagamento.status !== 'aprovado') {
    throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'estornado');
  }

  if (await deps.livroFinanceiroRepository.hasLancamentosTransferidos(pagamento.id)) {
    throw new PagamentoEstornoLancamentoJaTransferidoError(pagamento.id);
  }

  const now = deps.clock();
  const estornado = estornarPagamentoAprovado(pagamento, now);
  const venceuCas = await deps.pagamentoRepository.updateIfStatusIn(estornado, ['aprovado']);
  if (!venceuCas) {
    const canonical = await deps.pagamentoRepository.findByE2eExternalRef(parsed.e2eId);
    if (canonical?.status === 'estornado' && bindingMatches(updated, canonical)) {
      await deps.livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento(
        canonical.id,
        deps.clock(),
      );
      return { pagamentoId: canonical.id };
    }
    if (!canonical) {
      throw new PagamentoEstornoPixVinculoInvalidoError();
    }
    throw new PagamentoTransicaoStatusInvalidaError(canonical.id, canonical.status, 'estornado');
  }

  // Only the CAS winner owns the ledger side effect. Duplicate verified
  // callbacks converge on the canonical estornado payment above.
  await deps.livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento(
    pagamento.id,
    now,
  );
  return { pagamentoId: pagamento.id };
}

function bindingMatches(devolucao: PixCobrancaDevolucaoRecord, pagamento: Pagamento): boolean {
  const transacao = pagamento.transacaoExterna;
  return (
    devolucao.idPagamento === pagamento.id &&
    devolucao.e2eId === pagamento.intencao.e2eExternalRef &&
    devolucao.idDevolucao === pagamento.id.replaceAll('-', '') &&
    devolucao.amountCents === pagamento.intencao.composicaoValoresAggregate.totalPaidCents &&
    transacao?.provedor === 'inter' &&
    transacao.id === devolucao.e2eId &&
    transacao.amountCents === devolucao.amountCents
  );
}
