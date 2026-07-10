import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import {
  criarEvento as criarEventoDominio,
  type Evento,
  eventoComDataHora,
  eventoComTipo,
} from '../../domain/evento/entities/evento.js';
import { DataHoraEventoNullableSchema } from '../../domain/evento/value-objects/data-hora-evento.js';
import { IdCampanhaSchema, IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { TipoEventoSchema } from '../../domain/evento/value-objects/tipo-evento.js';
import { EventoInputInvalidoError } from '../../errors/evento/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const UpsertEventoParcialInputSchema = z.object({
  /** Id for the evento row IF one has to be created (caller-generated, uuid). */
  id: IdEventoSchema,
  idCampanha: IdCampanhaSchema,
  tipoEvento: TipoEventoSchema.nullable(),
  dataHora: DataHoraEventoNullableSchema,
});

export type UpsertEventoParcialInput = z.infer<typeof UpsertEventoParcialInputSchema>;

export interface UpsertEventoParcialDeps {
  readonly eventoRepository: EventoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * aperture-mu1v9 (fblrt W3-c) — the setup-wizard / perfil write path into the
 * SINGLE-SOURCE `eventos` aggregate. Writes ONLY the (tipoEvento, dataHora)
 * pair:
 *   - existing evento for the campanha → update those two fields, PRESERVING
 *     modalidade/endereco (and every other field) — a saved convite's
 *     where/how survives a wizard re-run;
 *   - no evento yet → create a PARTIAL row (modalidade/endereco null). The
 *     convite save (`criarEvento`/`atualizarEvento`) later fills it in;
 *   - no evento AND both values null → NO row is created (nothing to
 *     source; mirrors reconciliation case (c) of migration 037). Returns
 *     null so callers project the pair as absent.
 *
 * Auth is NOT enforced here — callers owner-gate `idCampanha` first.
 */
export async function upsertEventoParcial(
  deps: UpsertEventoParcialDeps,
  input: UpsertEventoParcialInput,
): Promise<Evento | null> {
  const { eventoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('upsertEventoParcial', async (span) => {
    try {
      const parsed = UpsertEventoParcialInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new EventoInputInvalidoError(message);
      }

      span.setAttribute('evento.campanha.id', parsed.data.idCampanha);

      const now = clock();
      const existing = await eventoRepository.findByIdCampanha(parsed.data.idCampanha);

      if (!existing && parsed.data.tipoEvento === null && parsed.data.dataHora === null) {
        span.setStatus({ code: SpanStatusCode.OK });
        return null;
      }

      const evento = existing
        ? eventoComDataHora(
            eventoComTipo(existing, parsed.data.tipoEvento, now),
            parsed.data.dataHora,
            now,
          )
        : criarEventoDominio({
            id: parsed.data.id,
            idCampanha: parsed.data.idCampanha,
            tipoEvento: parsed.data.tipoEvento,
            modalidade: null,
            dataHora: parsed.data.dataHora,
            endereco: null,
            criadoEm: now,
            atualizadoEm: now,
          });

      await eventoRepository.save(evento);

      logger.info('evento.parcial.upsert', {
        idEvento: evento.id,
        idCampanha: evento.idCampanha,
        criado: !existing,
        tipoEventoPresente: evento.tipoEvento !== null,
        dataHoraPresente: evento.dataHora !== null,
      });

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
