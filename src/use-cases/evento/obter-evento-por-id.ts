import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import type { Evento } from '../../domain/evento/entities/evento.js';
import { IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { EventoInputInvalidoError } from '../../errors/evento/input-invalido.error.js';
import { EventoNaoEncontradoError } from '../../errors/evento/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterEventoPorIdInputSchema = z.object({
  id: IdEventoSchema,
});

export type ObterEventoPorIdInput = z.infer<typeof ObterEventoPorIdInputSchema>;

export interface ObterEventoPorIdDeps {
  readonly eventoRepository: EventoRepository;
  readonly observability: Observability;
}

export async function obterEventoPorId(
  deps: ObterEventoPorIdDeps,
  input: ObterEventoPorIdInput,
): Promise<Evento> {
  const { eventoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterEventoPorId', async (span) => {
    try {
      const parsed = ObterEventoPorIdInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new EventoInputInvalidoError(message);
      }

      span.setAttribute('evento.id', parsed.data.id);

      const evento = await eventoRepository.findById(parsed.data.id);
      if (!evento) {
        throw new EventoNaoEncontradoError(parsed.data.id);
      }

      span.setAttribute('evento.campanha.id', evento.idCampanha);
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
