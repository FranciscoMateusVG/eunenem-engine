import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import type { Evento } from '../../domain/evento/entities/evento.js';
import { IdCampanhaSchema } from '../../domain/evento/value-objects/ids.js';
import { EventoInputInvalidoError } from '../../errors/evento/input-invalido.error.js';
import { EventoNaoEncontradoError } from '../../errors/evento/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterEventoPorIdCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
});

export type ObterEventoPorIdCampanhaInput = z.infer<typeof ObterEventoPorIdCampanhaInputSchema>;

export interface ObterEventoPorIdCampanhaDeps {
  readonly eventoRepository: EventoRepository;
  readonly observability: Observability;
}

export async function obterEventoPorIdCampanha(
  deps: ObterEventoPorIdCampanhaDeps,
  input: ObterEventoPorIdCampanhaInput,
): Promise<Evento> {
  const { eventoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterEventoPorIdCampanha', async (span) => {
    try {
      const parsed = ObterEventoPorIdCampanhaInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new EventoInputInvalidoError(message);
      }

      span.setAttribute('evento.campanha.id', parsed.data.idCampanha);

      const evento = await eventoRepository.findByIdCampanha(parsed.data.idCampanha);
      if (!evento) {
        throw new EventoNaoEncontradoError(undefined, parsed.data.idCampanha);
      }

      span.setAttribute('evento.id', evento.id);
      span.setStatus({ code: SpanStatusCode.OK });
      return evento;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
