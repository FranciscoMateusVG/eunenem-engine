import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import { type Campanha, campanhaComOpcao } from '../../domain/arrecadacao/entities/campanha.js';
import {
  IdCampanhaSchema,
  IdOpcaoContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import {
  type OpcaoContribuicao,
  TipoOpcaoContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/opcao-contribuicao.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoIdDuplicadoError } from '../../errors/arrecadacao/opcao-id-duplicado.error.js';
import type { Observability } from '../../observability/observability.js';

export const AdicionarOpcaoContribuicaoInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcao: IdOpcaoContribuicaoSchema,
  tipo: TipoOpcaoContribuicaoSchema,
});

export type AdicionarOpcaoContribuicaoInput = z.infer<typeof AdicionarOpcaoContribuicaoInputSchema>;

export interface AdicionarOpcaoContribuicaoDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Adiciona uma opção de contribuição a uma campanha existente.
 */
export async function adicionarOpcaoContribuicao(
  deps: AdicionarOpcaoContribuicaoDeps,
  input: AdicionarOpcaoContribuicaoInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('adicionarOpcaoContribuicao', async (span) => {
    try {
      const parsed = AdicionarOpcaoContribuicaoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idOpcao, tipo } = parsed.data;

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.opcao.id', idOpcao);

      const existing = await campanhaRepository.findById(idCampanha);
      if (!existing) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      if (existing.opcoes.some((o) => o.id === idOpcao)) {
        throw new ArrecadacaoOpcaoIdDuplicadoError(idOpcao);
      }

      const opcao: OpcaoContribuicao = { id: idOpcao, tipo };
      const updated = campanhaComOpcao(existing, opcao);

      await campanhaRepository.save(updated);

      logger.info('arrecadacao.campanha.opcao_adicionada', {
        idCampanha,
        idOpcao,
        tipo,
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
