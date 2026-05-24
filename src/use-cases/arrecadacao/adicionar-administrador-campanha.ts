import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import {
  type Campanha,
  campanhaComAdministrador,
  campanhaPossuiAdministrador,
} from '../../domain/arrecadacao/entities/campanha.js';
import { IdCampanhaSchema, IdContaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoAdministradorDuplicadoError } from '../../errors/arrecadacao/administrador-duplicado.error.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const AdicionarAdministradorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idConta: IdContaSchema,
});

export type AdicionarAdministradorCampanhaInput = z.infer<
  typeof AdicionarAdministradorCampanhaInputSchema
>;

export interface AdicionarAdministradorCampanhaDeps {
  readonly campanhaRepository: CampanhaRepository;
  readonly observability: Observability;
}

/**
 * Adiciona um administrador a uma campanha existente.
 */
export async function adicionarAdministradorCampanha(
  deps: AdicionarAdministradorCampanhaDeps,
  input: AdicionarAdministradorCampanhaInput,
): Promise<Campanha> {
  const { campanhaRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('adicionarAdministradorCampanha', async (span) => {
    try {
      const parsed = AdicionarAdministradorCampanhaInputSchema.safeParse(input);
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

      if (campanhaPossuiAdministrador(existing, idConta)) {
        throw new ArrecadacaoAdministradorDuplicadoError(idConta);
      }

      const updated = campanhaComAdministrador(existing, idConta);

      await campanhaRepository.save(updated);

      logger.info('arrecadacao.campanha.administrador_adicionado', {
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
