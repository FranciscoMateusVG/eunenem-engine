import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../adapters/financeiro-livro-repository.js';
import {
  calcularSaldoRecebedor,
  type ObterSaldoRecebedorInput,
  ObterSaldoRecebedorInputSchema,
  type SaldoRecebedor,
} from '../domain/financeiro.js';
import { FinanceiroInputInvalidoError } from '../errors/financeiro-input-invalido.error.js';
import type { Observability } from '../observability/observability.js';

export interface ObterSaldoRecebedorDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly observability: Observability;
}

/**
 * Consulta o saldo financeiro do recebedor a partir dos lançamentos registrados.
 */
export async function obterSaldoRecebedor(
  deps: ObterSaldoRecebedorDeps,
  input: ObterSaldoRecebedorInput,
): Promise<SaldoRecebedor> {
  const { livroFinanceiroRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterSaldoRecebedor', async (span) => {
    try {
      const parsed = ObterSaldoRecebedorInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }

      span.setAttribute('financeiro.recebedor.id', parsed.data.idRecebedor);

      const lancamentos = await livroFinanceiroRepository.findLancamentosByIdRecebedor(
        parsed.data.idRecebedor,
      );
      const saldo = calcularSaldoRecebedor(parsed.data.idRecebedor, lancamentos);

      span.setStatus({ code: SpanStatusCode.OK });
      return saldo;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
