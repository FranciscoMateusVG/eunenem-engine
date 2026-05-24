import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  aprovarPagamentoPendente,
  criarEventoPagamento,
  type Pagamento,
  podeAprovarPagamento,
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

export interface AprovarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Aprova um pagamento a partir de uma transação externa simulada pelo provedor fake.
 */
export async function aprovarPagamento(
  deps: AprovarPagamentoDeps,
  input: ComandoPagamentoInput,
): Promise<Pagamento> {
  const { pagamentoRepository, pagamentoProvider, pagamentoEventPublisher, clock, observability } =
    deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('aprovarPagamento', async (span) => {
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

      if (!podeAprovarPagamento(pagamento)) {
        throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'aprovado');
      }

      const transacao = await pagamentoProvider.solicitarPagamento({
        idPagamento: pagamento.id,
        idIntencaoPagamento: pagamento.intencao.id,
        amountCents: pagamento.intencao.amountCents,
        metodo: pagamento.intencao.metodo,
      });

      if (transacao.status !== 'aprovado') {
        throw new PagamentoTransicaoStatusInvalidaError(pagamento.id, pagamento.status, 'aprovado');
      }

      if (transacao.amountCents !== pagamento.intencao.amountCents) {
        throw new PagamentoValorDivergenteError(
          pagamento.intencao.amountCents,
          transacao.amountCents,
        );
      }

      const now = clock();
      const aprovado = aprovarPagamentoPendente(pagamento, transacao, now);
      await pagamentoRepository.update(aprovado);
      await pagamentoEventPublisher.publish(
        criarEventoPagamento({
          id: randomUUID(),
          tipo: 'payment.approved',
          pagamento: aprovado,
          ocorridoEm: now,
        }),
      );

      logger.info('pagamento.aprovado', {
        idPagamento: aprovado.id,
        idIntencaoPagamento: aprovado.intencao.id,
        idContribuicao: aprovado.intencao.idContribuicao,
        amountCents: aprovado.intencao.amountCents,
        idTransacaoExterna: transacao.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return aprovado;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
