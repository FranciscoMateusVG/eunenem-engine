import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoRepository } from '../adapters/pagamento-repository.js';
import {
  type ComandoPagamentoInput,
  ComandoPagamentoInputSchema,
  type Pagamento,
} from '../domain/pagamentos.js';
import { PagamentosInputInvalidoError } from '../errors/pagamentos-input-invalido.error.js';
import type { Observability } from '../observability/observability.js';

export interface ObterPagamentoPorIdDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly observability: Observability;
}

/**
 * Consulta um pagamento por ID sem acoplar o chamador ao adapter concreto.
 */
export async function obterPagamentoPorId(
  deps: ObterPagamentoPorIdDeps,
  input: ComandoPagamentoInput,
): Promise<Pagamento | undefined> {
  const { pagamentoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterPagamentoPorId', async (span) => {
    try {
      const parsed = ComandoPagamentoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PagamentosInputInvalidoError(message);
      }

      span.setAttribute('pagamento.id', parsed.data.idPagamento);

      const pagamento = await pagamentoRepository.findById(parsed.data.idPagamento);
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
