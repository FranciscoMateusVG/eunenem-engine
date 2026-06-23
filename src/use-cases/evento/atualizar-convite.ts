import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ConviteRepository } from '../../adapters/evento/convite-repository.js';
import type { Convite } from '../../domain/evento/entities/convite.js';
import { conviteComCamposAtualizados } from '../../domain/evento/entities/convite.js';
import { FonteConviteSchema } from '../../domain/evento/value-objects/fonte-convite.js';
import { IdConviteSchema } from '../../domain/evento/value-objects/ids.js';
import { ImagemUrlConviteSchema } from '../../domain/evento/value-objects/imagem-url-convite.js';
import { MensagemConviteSchema } from '../../domain/evento/value-objects/mensagem-convite.js';
import { ModeloConviteSchema } from '../../domain/evento/value-objects/modelo-convite.js';
import { NomeExibidoConviteSchema } from '../../domain/evento/value-objects/nome-exibido-convite.js';
import { PaletaConviteSchema } from '../../domain/evento/value-objects/paleta-convite.js';
import { RemetenteConviteSchema } from '../../domain/evento/value-objects/remetente-convite.js';
import { ConviteInputInvalidoError } from '../../errors/evento/convite-input-invalido.error.js';
import { ConviteNaoEncontradoError } from '../../errors/evento/convite-nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const AtualizarConviteInputSchema = z.object({
  id: IdConviteSchema,
  remetente: RemetenteConviteSchema,
  nomeExibido: NomeExibidoConviteSchema,
  mensagem: MensagemConviteSchema,
  paleta: PaletaConviteSchema,
  fonte: FonteConviteSchema,
  modelo: ModeloConviteSchema,
  imagemUrl: ImagemUrlConviteSchema.optional(),
});

export type AtualizarConviteInput = z.infer<typeof AtualizarConviteInputSchema>;

export interface AtualizarConviteDeps {
  readonly conviteRepository: ConviteRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function atualizarConvite(
  deps: AtualizarConviteDeps,
  input: AtualizarConviteInput,
): Promise<Convite> {
  const { conviteRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarConvite', async (span) => {
    try {
      const parsed = AtualizarConviteInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ConviteInputInvalidoError(message);
      }

      span.setAttribute('convite.id', parsed.data.id);
      span.setAttribute('convite.remetente.length', parsed.data.remetente.length);
      span.setAttribute('convite.paleta', parsed.data.paleta);
      span.setAttribute('convite.fonte', parsed.data.fonte);
      span.setAttribute('convite.modelo', parsed.data.modelo);
      if (parsed.data.imagemUrl !== undefined) {
        span.setAttribute('convite.imagem_url', parsed.data.imagemUrl);
      }

      const existing = await conviteRepository.findById(parsed.data.id);
      if (!existing) {
        throw new ConviteNaoEncontradoError(parsed.data.id);
      }

      const updated = conviteComCamposAtualizados(
        existing,
        {
          remetente: parsed.data.remetente,
          nomeExibido: parsed.data.nomeExibido,
          mensagem: parsed.data.mensagem,
          paleta: parsed.data.paleta,
          fonte: parsed.data.fonte,
          modelo: parsed.data.modelo,
          ...(parsed.data.imagemUrl === undefined ? {} : { imagemUrl: parsed.data.imagemUrl }),
        },
        clock(),
      );

      await conviteRepository.save(updated);

      logger.info('convite.atualizado', {
        idConvite: updated.id,
        idEvento: updated.idEvento,
        remetente: updated.remetente,
        paleta: updated.paleta,
        fonte: updated.fonte,
        modelo: updated.modelo,
        imagemUrl: updated.imagemUrl,
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
