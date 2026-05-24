import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Shared command input for use cases that address a payment by id:
 * `obterPagamentoPorId`, `aprovarPagamento`, `rejeitarPagamento`.
 *
 * Defined here as the simplest payment use case; the others import this shape
 * to avoid duplicating the schema.
 */
export const ComandoPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
});
export type ComandoPagamentoInput = z.infer<typeof ComandoPagamentoInputSchema>;

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
