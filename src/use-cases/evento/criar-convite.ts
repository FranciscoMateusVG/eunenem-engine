import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ConviteRepository } from '../../adapters/evento/convite-repository.js';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import {
  type Convite,
  criarConvite as criarConviteDominio,
} from '../../domain/evento/entities/convite.js';
import { FonteConviteSchema } from '../../domain/evento/value-objects/fonte-convite.js';
import { IdConviteSchema, IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { ImagemConviteSchema } from '../../domain/evento/value-objects/imagem-convite.js';
import { MensagemConviteSchema } from '../../domain/evento/value-objects/mensagem-convite.js';
import { ModeloConviteSchema } from '../../domain/evento/value-objects/modelo-convite.js';
import { NomeExibidoConviteSchema } from '../../domain/evento/value-objects/nome-exibido-convite.js';
import { PaletaConviteSchema } from '../../domain/evento/value-objects/paleta-convite.js';
import { ConviteInputInvalidoError } from '../../errors/evento/convite-input-invalido.error.js';
import { ConviteJaExisteError } from '../../errors/evento/convite-ja-existe.error.js';
import { EventoNaoEncontradoError } from '../../errors/evento/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const CriarConviteInputSchema = z.object({
  id: IdConviteSchema,
  idEvento: IdEventoSchema,
  nomeExibido: NomeExibidoConviteSchema,
  mensagem: MensagemConviteSchema,
  paleta: PaletaConviteSchema,
  fonte: FonteConviteSchema,
  modelo: ModeloConviteSchema,
  imagem: ImagemConviteSchema.optional(),
});

export type CriarConviteInput = z.infer<typeof CriarConviteInputSchema>;

export interface CriarConviteDeps {
  readonly conviteRepository: ConviteRepository;
  readonly eventoRepository: EventoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria o convite 1:1 de um evento existente.
 */
export async function criarConvite(
  deps: CriarConviteDeps,
  input: CriarConviteInput,
): Promise<Convite> {
  const { conviteRepository, eventoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarConvite', async (span) => {
    try {
      const parsed = CriarConviteInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ConviteInputInvalidoError(message);
      }

      const now = clock();
      span.setAttribute('convite.id', parsed.data.id);
      span.setAttribute('evento.id', parsed.data.idEvento);
      span.setAttribute('convite.paleta', parsed.data.paleta);
      span.setAttribute('convite.fonte', parsed.data.fonte);
      span.setAttribute('convite.modelo', parsed.data.modelo);
      if (parsed.data.imagem !== undefined) {
        span.setAttribute('convite.imagem', parsed.data.imagem);
      }

      const evento = await eventoRepository.findById(parsed.data.idEvento);
      if (!evento) {
        throw new EventoNaoEncontradoError(parsed.data.idEvento);
      }

      const existing = await conviteRepository.findByIdEvento(parsed.data.idEvento);
      if (existing) {
        throw new ConviteJaExisteError(parsed.data.idEvento);
      }

      const convite = criarConviteDominio({
        id: parsed.data.id,
        idEvento: parsed.data.idEvento,
        nomeExibido: parsed.data.nomeExibido,
        mensagem: parsed.data.mensagem,
        paleta: parsed.data.paleta,
        fonte: parsed.data.fonte,
        modelo: parsed.data.modelo,
        ...(parsed.data.imagem === undefined ? {} : { imagem: parsed.data.imagem }),
        criadoEm: now,
        atualizadoEm: now,
      });

      await conviteRepository.save(convite);

      logger.info('convite.criado', {
        idConvite: convite.id,
        idEvento: convite.idEvento,
        paleta: convite.paleta,
        fonte: convite.fonte,
        modelo: convite.modelo,
        imagem: convite.imagem,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return convite;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
