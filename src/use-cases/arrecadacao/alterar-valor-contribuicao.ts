import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import {
  type Contribuicao,
  contribuicaoAtualizada,
} from '../../domain/arrecadacao/entities/contribuicao.js';
import { IdContribuicaoSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../domain/money.js';
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
 * Altera o valor de uma contribuição.
 *
 * Plan 0015 (aperture-ucgok): o status guard foi removido. Slots não
 * têm mais FSM; o valor pode ser editado a qualquer momento. Pagamentos
 * já aprovados preservam o valor original no snapshot composicaoValores —
 * a edição não afeta retroativamente o que o contribuinte pagou.
 * Implementado em termos de `contribuicaoAtualizada` (o helper único)
 * desde que `contribuicaoComValor` foi removido com a redução do agregado.
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

      const updated = contribuicaoAtualizada(existing, { valor });
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
