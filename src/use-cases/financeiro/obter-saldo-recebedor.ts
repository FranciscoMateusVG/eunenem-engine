import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import { IdCampanhaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  calcularSaldoRecebedor,
  type SaldoRecebedor,
} from '../../domain/financeiro/value-objects/saldo-recebedor.js';
import { FinanceiroInputInvalidoError } from '../../errors/financeiro/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterSaldoRecebedorInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
});

export type ObterSaldoRecebedorInput = Readonly<z.infer<typeof ObterSaldoRecebedorInputSchema>>;

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

      span.setAttribute('financeiro.campanha.id', parsed.data.idCampanha);

      const lancamentos = await livroFinanceiroRepository.findLancamentosByIdCampanha(
        parsed.data.idCampanha,
      );
      const saldo = calcularSaldoRecebedor(parsed.data.idCampanha, lancamentos);

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
