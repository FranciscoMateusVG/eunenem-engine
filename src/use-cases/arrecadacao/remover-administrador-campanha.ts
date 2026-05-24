import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import {
  type Campanha,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
} from '../../domain/arrecadacao/entities/campanha.js';
import { IdCampanhaSchema, IdContaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoAdministradorNaoEncontradoError } from '../../errors/arrecadacao/administrador-nao-encontrado.error.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoUltimoAdministradorError } from '../../errors/arrecadacao/ultimo-administrador.error.js';
import type { Observability } from '../../observability/observability.js';

export const RemoverAdministradorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idConta: IdContaSchema,
});

export type RemoverAdministradorCampanhaInput = z.infer<
  typeof RemoverAdministradorCampanhaInputSchema
>;

export interface RemoverAdministradorCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Remove um administrador de uma campanha existente.
 */
export async function removerAdministradorCampanha(
  deps: RemoverAdministradorCampanhaDeps,
  input: RemoverAdministradorCampanhaInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('removerAdministradorCampanha', async (span) => {
    try {
      const parsed = RemoverAdministradorCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha, idConta } = parsed.data;

      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      span.setAttribute('arrecadacao.administrador.idConta', idConta);

      const existing = await campanhaRepository.findById(idCampanha);
      if (!existing) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(idCampanha);
      }

      if (!campanhaPossuiAdministrador(existing, idConta)) {
        throw new ArrecadacaoAdministradorNaoEncontradoError(idConta);
      }

      if (existing.idsAdministradores.length === 1) {
        throw new ArrecadacaoUltimoAdministradorError(idCampanha);
      }

      const updated = campanhaSemAdministrador(existing, idConta);

      await campanhaRepository.save(updated);

      logger.info('arrecadacao.campanha.administrador_removido', {
        idCampanha,
        idConta,
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
