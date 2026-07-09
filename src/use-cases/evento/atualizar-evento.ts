import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import type { Evento } from '../../domain/evento/entities/evento.js';
import { eventoComCamposAtualizados } from '../../domain/evento/entities/evento.js';
import { DataHoraEventoNullableSchema } from '../../domain/evento/value-objects/data-hora-evento.js';
import { EnderecoEventoNullableSchema } from '../../domain/evento/value-objects/endereco-evento.js';
import { IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { ModalidadeEventoSchema } from '../../domain/evento/value-objects/modalidade-evento.js';
import { TipoEventoSchema } from '../../domain/evento/value-objects/tipo-evento.js';
import { EventoInputInvalidoError } from '../../errors/evento/input-invalido.error.js';
import { EventoNaoEncontradoError } from '../../errors/evento/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const AtualizarEventoInputSchema = z.object({
  id: IdEventoSchema,
  tipoEvento: TipoEventoSchema,
  modalidade: ModalidadeEventoSchema,
  dataHora: DataHoraEventoNullableSchema,
  endereco: EnderecoEventoNullableSchema,
});

export type AtualizarEventoInput = z.infer<typeof AtualizarEventoInputSchema>;

export interface AtualizarEventoDeps {
  readonly eventoRepository: EventoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Atualiza tipo, modalidade, data/hora e endereço de um evento existente.
 */
export async function atualizarEvento(
  deps: AtualizarEventoDeps,
  input: AtualizarEventoInput,
): Promise<Evento> {
  const { eventoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarEvento', async (span) => {
    try {
      const parsed = AtualizarEventoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new EventoInputInvalidoError(message);
      }

      span.setAttribute('evento.id', parsed.data.id);
      span.setAttribute('evento.tipo', parsed.data.tipoEvento);
      span.setAttribute('evento.modalidade', parsed.data.modalidade);

      const existing = await eventoRepository.findById(parsed.data.id);
      if (!existing) {
        throw new EventoNaoEncontradoError(parsed.data.id);
      }

      const updated = eventoComCamposAtualizados(
        existing,
        {
          tipoEvento: parsed.data.tipoEvento,
          modalidade: parsed.data.modalidade,
          dataHora: parsed.data.dataHora,
          endereco: parsed.data.endereco,
        },
        clock(),
      );

      await eventoRepository.save(updated);

      logger.info('evento.atualizado', {
        idEvento: updated.id,
        idCampanha: updated.idCampanha,
        enderecoPresente: updated.endereco !== null,
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
