import { SpanStatusCode } from '@opentelemetry/api';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type {
  AssociarContribuinteContribuicaoInput,
  Contribuicao,
} from '../../domain/arrecadacao/contribuicao.js';
import {
  AssociarContribuinteContribuicaoInputSchema,
  contribuicaoComContribuinte,
  contribuicaoDisponivel,
} from '../../domain/arrecadacao/contribuicao.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export interface AssociarContribuinteContribuicaoDeps {
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

/**
 * Visitante associa dados à contribuição disponível; status passa a `indisponivel`.
 */
export async function associarContribuinteContribuicao(
  deps: AssociarContribuinteContribuicaoDeps,
  input: AssociarContribuinteContribuicaoInput,
): Promise<Contribuicao> {
  const { contribuicaoRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('associarContribuinteContribuicao', async (span) => {
    try {
      const parsed = AssociarContribuinteContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idContribuicao, contribuinte } = parsed.data;
      span.setAttribute('arrecadacao.contribuicao.id', idContribuicao);

      const existing = await contribuicaoRepository.findById(idContribuicao);
      if (!existing) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      if (!contribuicaoDisponivel(existing)) {
        throw new ArrecadacaoContribuicaoNaoDisponivelError(idContribuicao);
      }

      const updated = contribuicaoComContribuinte(existing, contribuinte);
      await contribuicaoRepository.save(updated);

      logger.info('arrecadacao.contribuicao.contribuinte_associado', {
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
