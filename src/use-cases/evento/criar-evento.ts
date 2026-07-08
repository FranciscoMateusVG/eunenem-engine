import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import {
  criarEvento as criarEventoDominio,
  type Evento,
} from '../../domain/evento/entities/evento.js';
import { DataHoraEventoNullableSchema } from '../../domain/evento/value-objects/data-hora-evento.js';
import { EnderecoEventoNullableSchema } from '../../domain/evento/value-objects/endereco-evento.js';
import { IdCampanhaSchema, IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { ModalidadeEventoSchema } from '../../domain/evento/value-objects/modalidade-evento.js';
import { TipoEventoSchema } from '../../domain/evento/value-objects/tipo-evento.js';
import { EventoCampanhaJaTemEventoError } from '../../errors/evento/campanha-ja-tem-evento.error.js';
import { EventoCampanhaNaoEncontradaError } from '../../errors/evento/campanha-nao-encontrada.error.js';
import { EventoInputInvalidoError } from '../../errors/evento/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const CriarEventoInputSchema = z.object({
  id: IdEventoSchema,
  idCampanha: IdCampanhaSchema,
  tipoEvento: TipoEventoSchema,
  modalidade: ModalidadeEventoSchema,
  dataHora: DataHoraEventoNullableSchema,
  endereco: EnderecoEventoNullableSchema,
});

export type CriarEventoInput = z.infer<typeof CriarEventoInputSchema>;

export interface CriarEventoDeps {
  readonly eventoRepository: EventoRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria o evento 1:1 de uma campanha existente.
 */
export async function criarEvento(deps: CriarEventoDeps, input: CriarEventoInput): Promise<Evento> {
  const { eventoRepository, campanhaRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarEvento', async (span) => {
    try {
      const parsed = CriarEventoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new EventoInputInvalidoError(message);
      }

      const now = clock();
      span.setAttribute('evento.id', parsed.data.id);
      span.setAttribute('evento.campanha.id', parsed.data.idCampanha);
      span.setAttribute('evento.tipo', parsed.data.tipoEvento);
      span.setAttribute('evento.modalidade', parsed.data.modalidade);

      const campanha = await campanhaRepository.findById(parsed.data.idCampanha);
      if (!campanha) {
        throw new EventoCampanhaNaoEncontradaError(parsed.data.idCampanha);
      }

      span.setAttribute('evento.plataforma.id', campanha.idPlataforma);

      const existing = await eventoRepository.findByIdCampanha(parsed.data.idCampanha);
      if (existing) {
        throw new EventoCampanhaJaTemEventoError(parsed.data.idCampanha);
      }

      const evento = criarEventoDominio({
        id: parsed.data.id,
        idCampanha: parsed.data.idCampanha,
        tipoEvento: parsed.data.tipoEvento,
        modalidade: parsed.data.modalidade,
        dataHora: parsed.data.dataHora,
        endereco: parsed.data.endereco,
        criadoEm: now,
        atualizadoEm: now,
      });

      await eventoRepository.save(evento);

      logger.info('evento.criado', {
        idEvento: evento.id,
        idCampanha: evento.idCampanha,
        tipoEvento: evento.tipoEvento,
        modalidade: evento.modalidade,
        enderecoPresente: evento.endereco !== null,
      });

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
