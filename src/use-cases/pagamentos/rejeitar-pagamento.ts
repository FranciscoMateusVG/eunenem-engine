import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  type ComandoPagamentoInput,
  ComandoPagamentoInputSchema,
  criarEventoPagamento,
  type Pagamento,
  podeRejeitarPagamento,
  rejeitarPagamentoPendente,
} from '../../domain/pagamentos/pagamentos.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import { PagamentoValorDivergenteError } from '../../errors/pagamentos/valor-divergente.error.js';
import type { Observability } from '../../observability/observability.js';

export interface RejeitarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

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

      const transacao = await pagamentoProvider.solicitarPagamento({
        idPagamento: pagamento.id,
        idIntencaoPagamento: pagamento.intencao.id,
        amountCents: pagamento.intencao.amountCents,
        metodo: pagamento.intencao.metodo,
      });

      if (transacao.status !== 'rejeitado') {
        throw new PagamentoTransicaoStatusInvalidaError(
          pagamento.id,
          pagamento.status,
          'rejeitado',
        );
      }

      if (transacao.amountCents !== pagamento.intencao.amountCents) {
        throw new PagamentoValorDivergenteError(
          pagamento.intencao.amountCents,
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
        idContribuicao: rejeitado.intencao.idContribuicao,
        amountCents: rejeitado.intencao.amountCents,
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
