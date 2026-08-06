import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { LivroFinanceiroRepository } from '../../adapters/pagamentos/financeiro/livro-repository.js';
import type {
  PixCobrancaDevolucaoRecord,
  PixCobrancaDevolucaoRepository,
} from '../../adapters/pagamentos/pix-cobranca-devolucao-repository.js';
import {
  type DevolucaoOutcome,
  type PixCobrancaProvider,
  PixCobrancaTransitoriaError,
} from '../../adapters/pagamentos/pix-cobranca-provider.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  estornarPagamentoAprovado,
  type Pagamento,
} from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoPixNaoConcluidoError,
  PagamentoEstornoPixVinculoInvalidoError,
  PagamentoEstornoRecusadoPeloProvedorError,
} from './estorno-pagamento-errors.js';
import { finalizarEstornoPixVerificado } from './finalizar-estorno-pix-verificado.js';

export {
  PagamentoEstornoLancamentoJaTransferidoError,
  PagamentoEstornoPixNaoConcluidoError,
  PagamentoEstornoPixVinculoInvalidoError,
  PagamentoEstornoRecusadoPeloProvedorError,
} from './estorno-pagamento-errors.js';

export const EstornarPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
  /**
   * Optional reason for the refund. Threaded to the provider's refund
   * call (Stripe's `reason` field). Defaults to `requested_by_customer`
   * when unset (provider-side default also).
   */
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
});

export type EstornarPagamentoInput = z.infer<typeof EstornarPagamentoInputSchema>;

export interface EstornarPagamentoResult {
  readonly pagamento: Pagamento;
  readonly refundId: string;
  readonly refundStatus: 'aceito' | 'em_processamento' | 'devolvida';
}

export interface EstornarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pixCobrancaProvider: PixCobrancaProvider;
  readonly pixCobrancaDevolucaoRepository: PixCobrancaDevolucaoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Admin refund orchestration with provider-provenance routing.
 *
 * Historical payments keep the Stripe-compatible refund port and its
 * idempotency key. Banco Inter payments first persist a deterministic pending
 * identity, issue at most one PUT, and resolve every replay through an
 * authoritative GET. Only a persisted `devolvida` fact may enter the
 * provider-free local finalizer. The ledger transfer gate always runs before
 * the first external money call.
 */
export async function estornarPagamento(
  deps: EstornarPagamentoDeps,
  input: EstornarPagamentoInput,
): Promise<EstornarPagamentoResult> {
  const { pagamentoRepository, livroFinanceiroRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('estornarPagamento', async (span) => {
    try {
      const parsed = EstornarPagamentoInputSchema.parse(input);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);
      if (parsed.reason) span.setAttribute('refund.reason', parsed.reason);

      const pagamento = await pagamentoRepository.findById(parsed.idPagamento);
      if (!pagamento) throw new PagamentoNaoEncontradoError(parsed.idPagamento);

      if (pagamento.status === 'estornado') {
        const replay = await replayJaEstornado(deps, pagamento);
        logger.info('checkout.pagamento.replay_estorno', { idPagamento: pagamento.id });
        span.setStatus({ code: SpanStatusCode.OK });
        return replay;
      }
      if (pagamento.status !== 'aprovado') {
        throw new PagamentoTransicaoStatusInvalidaError(
          pagamento.id,
          pagamento.status,
          'estornado',
        );
      }

      // This gate precedes every external money call, for both providers.
      if (await livroFinanceiroRepository.hasLancamentosTransferidos(pagamento.id)) {
        throw new PagamentoEstornoLancamentoJaTransferidoError(pagamento.id);
      }

      const result =
        pagamento.transacaoExterna?.provedor === 'inter'
          ? await estornarInter(deps, pagamento)
          : await estornarHistorico(deps, pagamento, parsed.reason);
      span.setAttribute('refund.id', result.refundId);
      span.setAttribute('refund.status', result.refundStatus);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function estornarHistorico(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
  reason: EstornarPagamentoInput['reason'],
): Promise<EstornarPagamentoResult> {
  const refundResult = await deps.pagamentoProvider.refundarPagamento({
    idPagamento: pagamento.id,
    e2eExternalRef: pagamento.intencao.e2eExternalRef,
    chargeExternalRef: pagamento.intencao.chargeExternalRef,
    paymentIntentExternalRef: pagamento.intencao.paymentIntentExternalRef,
    amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
    ...(reason ? { reason } : {}),
  });
  if (refundResult.status === 'recusado') {
    throw new PagamentoEstornoRecusadoPeloProvedorError(pagamento.id, refundResult.statusBruto);
  }

  const now = deps.clock();
  const estornado = estornarPagamentoAprovado(pagamento, now);
  await deps.pagamentoRepository.update(estornado);
  await deps.livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento(
    pagamento.id,
    now,
  );
  deps.observability.logger.info('checkout.pagamento.estornado', {
    idPagamento: pagamento.id,
    refundId: refundResult.id,
    refundReason: reason ?? 'requested_by_customer',
  });
  return { pagamento: estornado, refundId: refundResult.id, refundStatus: 'aceito' };
}

async function estornarInter(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
): Promise<EstornarPagamentoResult> {
  const e2eId = pagamento.intencao.e2eExternalRef;
  const transacao = pagamento.transacaoExterna;
  const amountCents = pagamento.intencao.composicaoValoresAggregate.totalPaidCents;
  if (
    !e2eId ||
    transacao?.provedor !== 'inter' ||
    transacao.id !== e2eId ||
    transacao.amountCents !== amountCents
  ) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  const idDevolucao = pagamento.id.replaceAll('-', '');
  const established = await deps.pixCobrancaDevolucaoRepository.createIfAbsent({
    id: randomUUID(),
    idPagamento: pagamento.id,
    e2eId,
    idDevolucao,
    amountCents,
    criadoEm: deps.clock(),
  });

  if (!bindingMatches(established.record, pagamento)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  if (!established.created) {
    return replayInter(deps, pagamento, established.record);
  }

  try {
    const outcome = await deps.pixCobrancaProvider.solicitarDevolucao({
      e2eId,
      idDevolucao,
      amountCents,
    });
    return persistirOutcomeInter(deps, pagamento, established.record, outcome);
  } catch (error) {
    // A definitely pre-send failure may be retried with the same deterministic
    // identity. Ambiguous failures deliberately leave the pending row in place;
    // replays consult Inter before any further PUT.
    if (error instanceof PixCobrancaTransitoriaError) {
      await deps.pixCobrancaDevolucaoRepository.deleteIfPending({
        e2eId,
        idDevolucao,
      });
    }
    throw error;
  }
}

async function replayInter(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
  record: PixCobrancaDevolucaoRecord,
): Promise<EstornarPagamentoResult> {
  if (record.status === 'devolvida') {
    return finalizarInterLocalmente(deps, pagamento, record);
  }
  if (record.status === 'nao_realizada' || record.status === 'rejeitada') {
    throw new PagamentoEstornoPixNaoConcluidoError(pagamento.id, record.status);
  }

  // Existing pending means a prior PUT may have reached Inter. The only safe
  // replay is an authoritative GET; never issue a second PUT from this path.
  const outcome = await deps.pixCobrancaProvider.consultarDevolucao(
    record.e2eId,
    record.idDevolucao,
  );
  return persistirOutcomeInter(deps, pagamento, record, outcome);
}

async function persistirOutcomeInter(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
  record: PixCobrancaDevolucaoRecord,
  outcome: DevolucaoOutcome,
): Promise<EstornarPagamentoResult> {
  const updated = await deps.pixCobrancaDevolucaoRepository.updateOutcome({
    e2eId: record.e2eId,
    idDevolucao: record.idDevolucao,
    status: outcome.status,
    ...(outcome.status === 'em_processamento' ? { rtrId: outcome.rtrId } : {}),
    atualizadoEm: deps.clock(),
  });
  if (!updated || !bindingMatches(updated, pagamento)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }

  // A verified callback can race the provider response. Always branch on the
  // canonical persisted lifecycle, never on the stale raw response.
  if (updated.status === 'devolvida') {
    return finalizarInterLocalmente(deps, pagamento, updated);
  }
  if (updated.status === 'nao_realizada' || updated.status === 'rejeitada') {
    throw new PagamentoEstornoPixNaoConcluidoError(pagamento.id, updated.status);
  }
  return {
    pagamento,
    refundId: record.idDevolucao,
    refundStatus: 'em_processamento',
  };
}

async function finalizarInterLocalmente(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
  record: PixCobrancaDevolucaoRecord,
): Promise<EstornarPagamentoResult> {
  await finalizarEstornoPixVerificado(
    {
      pagamentoRepository: deps.pagamentoRepository,
      pixCobrancaDevolucaoRepository: deps.pixCobrancaDevolucaoRepository,
      livroFinanceiroRepository: deps.livroFinanceiroRepository,
      clock: deps.clock,
    },
    { e2eId: record.e2eId, idDevolucao: record.idDevolucao },
  );
  const canonical = await deps.pagamentoRepository.findById(pagamento.id);
  if (!canonical || canonical.status !== 'estornado' || !bindingMatches(record, canonical)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }
  return {
    pagamento: canonical,
    refundId: record.idDevolucao,
    refundStatus: 'devolvida',
  };
}

async function replayJaEstornado(
  deps: EstornarPagamentoDeps,
  pagamento: Pagamento,
): Promise<EstornarPagamentoResult> {
  if (pagamento.transacaoExterna?.provedor !== 'inter') {
    return { pagamento, refundId: 'replay', refundStatus: 'aceito' };
  }
  const record = await deps.pixCobrancaDevolucaoRepository.findByPagamentoId(pagamento.id);
  if (!record || record.status !== 'devolvida' || !bindingMatches(record, pagamento)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }
  await finalizarEstornoPixVerificado(
    {
      pagamentoRepository: deps.pagamentoRepository,
      pixCobrancaDevolucaoRepository: deps.pixCobrancaDevolucaoRepository,
      livroFinanceiroRepository: deps.livroFinanceiroRepository,
      clock: deps.clock,
    },
    { e2eId: record.e2eId, idDevolucao: record.idDevolucao },
  );
  const canonical = await deps.pagamentoRepository.findById(pagamento.id);
  if (!canonical || canonical.status !== 'estornado' || !bindingMatches(record, canonical)) {
    throw new PagamentoEstornoPixVinculoInvalidoError();
  }
  return { pagamento: canonical, refundId: record.idDevolucao, refundStatus: 'devolvida' };
}

function bindingMatches(record: PixCobrancaDevolucaoRecord, pagamento: Pagamento): boolean {
  return (
    record.idPagamento === pagamento.id &&
    record.e2eId === pagamento.intencao.e2eExternalRef &&
    record.idDevolucao === pagamento.id.replaceAll('-', '') &&
    record.amountCents === pagamento.intencao.composicaoValoresAggregate.totalPaidCents &&
    pagamento.transacaoExterna?.provedor === 'inter' &&
    pagamento.transacaoExterna.id === record.e2eId &&
    pagamento.transacaoExterna.amountCents === record.amountCents
  );
}
