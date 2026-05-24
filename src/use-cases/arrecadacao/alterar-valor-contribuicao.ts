import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import {
  contribuicaoComValor,
  contribuicaoDisponivel,
} from '../../domain/arrecadacao/entities/contribuicao.js';
import { IdContribuicaoSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const AlterarValorContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  valor: MoneyCentsSchema,
});

export type AlterarValorContribuicaoInput = z.infer<typeof AlterarValorContribuicaoInputSchema>;

export interface AlterarValorContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

/**
 * Altera o valor de uma contribuição enquanto ela está `disponivel`.
 */
export async function alterarValorContribuicao(
  deps: AlterarValorContribuicaoDeps,
  input: AlterarValorContribuicaoInput,
): Promise<Contribuicao> {
  const { contribuicaoRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('alterarValorContribuicao', async (span) => {
    try {
      const parsed = AlterarValorContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idContribuicao, valor } = parsed.data;
      span.setAttribute('arrecadacao.contribuicao.id', idContribuicao);

      const existing = await contribuicaoRepository.findById(idContribuicao);
      if (!existing) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      if (!contribuicaoDisponivel(existing)) {
        throw new ArrecadacaoContribuicaoNaoDisponivelError(idContribuicao);
      }

      const updated = contribuicaoComValor(existing, valor);
      await contribuicaoRepository.save(updated);

      logger.info('arrecadacao.contribuicao.valor_alterado', {
        idContribuicao,
        valor,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return updated;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
