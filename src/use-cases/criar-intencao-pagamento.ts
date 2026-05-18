import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoEventPublisher } from '../adapters/pagamento-event-publisher.js';
import type { PagamentoRepository } from '../adapters/pagamento-repository.js';
import {
  type CriarIntencaoPagamentoInput,
  CriarIntencaoPagamentoInputSchema,
  criarEventoPagamento,
  criarPagamentoPendente,
  type Pagamento,
} from '../domain/pagamentos.js';
import { PagamentoJaExisteError } from '../errors/pagamento-ja-existe.error.js';
import { PagamentoValorDivergenteError } from '../errors/pagamento-valor-divergente.error.js';
import { PagamentosInputInvalidoError } from '../errors/pagamentos-input-invalido.error.js';
import type { Observability } from '../observability/observability.js';

export interface CriarIntencaoPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria uma intenção de pagamento sem conhecer campanha, presente, rifa ou convite.
 */
export async function criarIntencaoPagamento(
  deps: CriarIntencaoPagamentoDeps,
  input: CriarIntencaoPagamentoInput,
): Promise<Pagamento> {
  const { pagamentoRepository, pagamentoEventPublisher, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarIntencaoPagamento', async (span) => {
    try {
      const parsed = CriarIntencaoPagamentoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PagamentosInputInvalidoError(message);
      }

      const { idPagamento, idIntencaoPagamento, composicaoValores, valorACobrarCents, metodo } =
        parsed.data;

      span.setAttribute('pagamento.id', idPagamento);
      span.setAttribute('pagamento.intencao.id', idIntencaoPagamento);
      span.setAttribute('pagamento.contribuicao.id', composicaoValores.idContribuicao);
      span.setAttribute('pagamento.amount_cents', valorACobrarCents);
      span.setAttribute('pagamento.method', metodo);

      if (valorACobrarCents !== composicaoValores.totalPaidCents) {
        throw new PagamentoValorDivergenteError(
          composicaoValores.totalPaidCents,
          valorACobrarCents,
        );
      }

      const existing = await pagamentoRepository.findById(idPagamento);
      if (existing) {
        throw new PagamentoJaExisteError(idPagamento, idIntencaoPagamento);
      }

      const now = clock();
      const pagamento = criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento,
        composicaoValores,
        valorACobrarCents,
        metodo,
        criadoEm: now,
      });

      await pagamentoRepository.save(pagamento);
      await pagamentoEventPublisher.publish(
        criarEventoPagamento({
          id: randomUUID(),
          tipo: 'payment.intent_created',
          pagamento,
          ocorridoEm: now,
        }),
      );

      logger.info('pagamento.intencao_criada', {
        idPagamento,
        idIntencaoPagamento,
        idContribuicao: pagamento.intencao.idContribuicao,
        amountCents: pagamento.intencao.amountCents,
        metodo,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return pagamento;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
