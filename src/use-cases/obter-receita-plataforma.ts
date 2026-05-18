import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../adapters/financeiro-livro-repository.js';
import { calcularReceitaPlataforma, type ReceitaPlataforma } from '../domain/financeiro.js';
import type { Observability } from '../observability/observability.js';

export interface ObterReceitaPlataformaDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly observability: Observability;
}

/**
 * Consulta a receita acumulada da plataforma a partir dos lançamentos financeiros.
 */
export async function obterReceitaPlataforma(
  deps: ObterReceitaPlataformaDeps,
): Promise<ReceitaPlataforma> {
  const { livroFinanceiroRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterReceitaPlataforma', async (span) => {
    try {
      const lancamentos = await livroFinanceiroRepository.findLancamentosReceitaPlataforma();
      const receita = calcularReceitaPlataforma(lancamentos);

      span.setStatus({ code: SpanStatusCode.OK });
      return receita;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
