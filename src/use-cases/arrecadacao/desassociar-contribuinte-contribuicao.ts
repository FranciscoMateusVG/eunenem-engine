import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import {
  type Contribuicao,
  contribuicaoDisponivel,
  contribuicaoSemContribuinte,
} from '../../domain/arrecadacao/entities/contribuicao.js';
import { IdContribuicaoSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoContribuicaoJaDisponivelError } from '../../errors/arrecadacao/contribuicao-ja-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const DesassociarContribuinteContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
});

export type DesassociarContribuinteContribuicaoInput = z.infer<
  typeof DesassociarContribuinteContribuicaoInputSchema
>;

export interface DesassociarContribuinteContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

/**
 * Compensa a associação: devolve a contribuição ao estado `disponivel`,
 * removendo o contribuinte. Lança `ArrecadacaoContribuicaoJaDisponivelError`
 * se já estiver disponível (guard de idempotência — sinal de "nada a
 * fazer" para o caller, não um erro real).
 */
export async function desassociarContribuinteContribuicao(
  deps: DesassociarContribuinteContribuicaoDeps,
  input: DesassociarContribuinteContribuicaoInput,
): Promise<Contribuicao> {
  const { contribuicaoRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('desassociarContribuinteContribuicao', async (span) => {
    try {
      const parsed = DesassociarContribuinteContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idContribuicao } = parsed.data;
      span.setAttribute('arrecadacao.contribuicao.id', idContribuicao);

      const existing = await contribuicaoRepository.findById(idContribuicao);
      if (!existing) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      if (contribuicaoDisponivel(existing)) {
        throw new ArrecadacaoContribuicaoJaDisponivelError(idContribuicao);
      }

      const updated = contribuicaoSemContribuinte(existing);
      await contribuicaoRepository.save(updated);

      logger.info('arrecadacao.contribuicao.contribuinte_desassociado', {
        idContribuicao,
        status: updated.status,
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
