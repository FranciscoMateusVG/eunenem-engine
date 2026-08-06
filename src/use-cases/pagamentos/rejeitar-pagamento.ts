import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  criarEventoPagamento,
  type Pagamento,
  podeRejeitarPagamento,
  rejeitarPagamentoPendente,
  type TransacaoExterna,
  TransacaoExternaSchema,
} from '../../domain/pagamentos/entities/pagamento.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import { PagamentoValorDivergenteError } from '../../errors/pagamentos/valor-divergente.error.js';
import type { Observability } from '../../observability/observability.js';
import {
  type ComandoPagamentoInput,
  ComandoPagamentoInputSchema,
} from './obter-pagamento-por-id.js';

export interface RejeitarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export type RejeitarPagamentoComTransacaoVerificadaDeps = Omit<
  RejeitarPagamentoDeps,
  'pagamentoProvider'
>;

export interface RejeitarPagamentoComTransacaoVerificadaInput extends ComandoPagamentoInput {
  /**
   * Provider result already verified through an authoritative read. This
   * seam performs bookkeeping only and never calls PagamentoProvider.
   */
  readonly transacao: TransacaoExterna;
}

const STATUS_ORIGEM_VERIFICADA = ['pendente', 'processing'] as const;

/**
 * Rejeita um pagamento a partir de uma transação externa simulada pelo provedor fake.
 */
export async function rejeitarPagamento(
  deps: RejeitarPagamentoDeps,
  input: ComandoPagamentoInput,
): Promise<Pagamento> {
  const { pagamentoRepository, pagamentoProvider, pagamentoEventPublisher, clock, observability } =
    deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('rejeitarPagamento', async (span) => {
    try {
      const parsed = ComandoPagamentoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PagamentosInputInvalidoError(message);
      }

      span.setAttribute('pagamento.id', parsed.data.idPagamento);

      const pagamento = await pagamentoRepository.findById(parsed.data.idPagamento);
      if (!pagamento) {
        throw new PagamentoNaoEncontradoError(parsed.data.idPagamento);
      }

      if (!podeRejeitarPagamento(pagamento)) {
        throw new PagamentoTransicaoStatusInvalidaError(
          pagamento.id,
          pagamento.status,
          'rejeitado',
        );
      }

      // Thread externalRef (aperture-xaha2): see aprovar-pagamento.ts.
      const transacao = await pagamentoProvider.solicitarPagamento({
        idPagamento: pagamento.id,
        idIntencaoPagamento: pagamento.intencao.id,
        amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
        metodo: pagamento.intencao.metodo,
        externalRef: pagamento.intencao.externalRef,
      });

      if (transacao.status !== 'rejeitado') {
        throw new PagamentoTransicaoStatusInvalidaError(
          pagamento.id,
          pagamento.status,
          'rejeitado',
        );
      }

      if (transacao.amountCents !== pagamento.intencao.composicaoValoresAggregate.totalPaidCents) {
        throw new PagamentoValorDivergenteError(
          pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
          transacao.amountCents,
        );
      }

      const now = clock();
      const rejeitado = rejeitarPagamentoPendente(pagamento, transacao, now);
      await pagamentoRepository.update(rejeitado);
      await pagamentoEventPublisher.publish(
        criarEventoPagamento({
          id: randomUUID(),
          tipo: 'payment.rejected',
          pagamento: rejeitado,
          ocorridoEm: now,
        }),
      );

      logger.info('pagamento.rejeitado', {
        idPagamento: rejeitado.id,
        idIntencaoPagamento: rejeitado.intencao.id,
        idCampanha: rejeitado.intencao.idCampanha,
        numeroDeItens: rejeitado.intencao.items.length,
        amountCents: rejeitado.intencao.composicaoValoresAggregate.totalPaidCents,
        idTransacaoExterna: transacao.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return rejeitado;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Reject a payment from an already-authoritatively-verified provider fact.
 *
 * The CAS prevents concurrent webhook/poller workers from both publishing
 * `payment.rejected`. A CAS loser rereads the canonical row and accepts only
 * the same provider transaction fact as an idempotent replay.
 */
export async function rejeitarPagamentoComTransacaoVerificada(
  deps: RejeitarPagamentoComTransacaoVerificadaDeps,
  input: RejeitarPagamentoComTransacaoVerificadaInput,
): Promise<Pagamento> {
  const parsedInput = ComandoPagamentoInputSchema.safeParse(input);
  if (!parsedInput.success) {
    const message = parsedInput.error.issues.map((issue) => issue.message).join('; ');
    throw new PagamentosInputInvalidoError(message);
  }
  const transacao = TransacaoExternaSchema.parse(input.transacao);
  const pagamento = await deps.pagamentoRepository.findById(parsedInput.data.idPagamento);
  if (!pagamento) {
    throw new PagamentoNaoEncontradoError(parsedInput.data.idPagamento);
  }

  if (pagamento.status === 'rejeitado') {
    validarRepeticaoVerificada(pagamento, transacao);
    return pagamento;
  }
  if (!podeRejeitarPagamento(pagamento)) {
    throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'rejeitado');
  }

  validarTransacaoRejeitada(pagamento, transacao);
  const now = deps.clock();
  const rejeitado = rejeitarPagamentoPendente(pagamento, transacao, now);
  const venceuCas = await deps.pagamentoRepository.updateIfStatusIn(
    rejeitado,
    STATUS_ORIGEM_VERIFICADA,
  );

  if (!venceuCas) {
    const canonical = await deps.pagamentoRepository.findById(pagamento.id);
    if (!canonical) {
      throw new PagamentoNaoEncontradoError(pagamento.id);
    }
    if (canonical.status === 'rejeitado') {
      validarRepeticaoVerificada(canonical, transacao);
      return canonical;
    }
    throw new PagamentoTransicaoStatusInvalidaError(canonical.id, canonical.status, 'rejeitado');
  }

  await publicarRejeicaoVerificada(deps, rejeitado, transacao, now);
  return rejeitado;
}

function validarTransacaoRejeitada(pagamento: Pagamento, transacao: TransacaoExterna): void {
  if (transacao.status !== 'rejeitado') {
    throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'rejeitado');
  }
  if (transacao.amountCents !== pagamento.intencao.composicaoValoresAggregate.totalPaidCents) {
    throw new PagamentoValorDivergenteError(
      pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      transacao.amountCents,
    );
  }
}

function validarRepeticaoVerificada(pagamento: Pagamento, transacao: TransacaoExterna): void {
  const existente = pagamento.transacaoExterna;
  if (
    !existente ||
    existente.id !== transacao.id ||
    existente.provedor !== transacao.provedor ||
    existente.status !== transacao.status ||
    existente.amountCents !== transacao.amountCents
  ) {
    throw new PagamentosInputInvalidoError(
      'transacao verificada diverge do pagamento ja rejeitado',
    );
  }
}

async function publicarRejeicaoVerificada(
  deps: RejeitarPagamentoComTransacaoVerificadaDeps,
  rejeitado: Pagamento,
  transacao: TransacaoExterna,
  ocorridoEm: Date,
): Promise<void> {
  await deps.pagamentoEventPublisher.publish(
    criarEventoPagamento({
      id: randomUUID(),
      tipo: 'payment.rejected',
      pagamento: rejeitado,
      ocorridoEm,
    }),
  );

  deps.observability.logger.info('pagamento.rejeitado', {
    idPagamento: rejeitado.id,
    idIntencaoPagamento: rejeitado.intencao.id,
    idCampanha: rejeitado.intencao.idCampanha,
    numeroDeItens: rejeitado.intencao.items.length,
    amountCents: rejeitado.intencao.composicaoValoresAggregate.totalPaidCents,
    idTransacaoExterna: transacao.id,
  });
}
