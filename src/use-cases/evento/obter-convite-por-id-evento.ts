import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ConviteRepository } from '../../adapters/evento/convite-repository.js';
import type { Convite } from '../../domain/evento/entities/convite.js';
import { IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { ConviteInputInvalidoError } from '../../errors/evento/convite-input-invalido.error.js';
import { ConviteNaoEncontradoError } from '../../errors/evento/convite-nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterConvitePorIdEventoInputSchema = z.object({
  idEvento: IdEventoSchema,
});

export type ObterConvitePorIdEventoInput = z.infer<typeof ObterConvitePorIdEventoInputSchema>;

export interface ObterConvitePorIdEventoDeps {
  readonly conviteRepository: ConviteRepository;
  readonly observability: Observability;
}

export async function obterConvitePorIdEvento(
  deps: ObterConvitePorIdEventoDeps,
  input: ObterConvitePorIdEventoInput,
): Promise<Convite> {
  const { conviteRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterConvitePorIdEvento', async (span) => {
    try {
      const parsed = ObterConvitePorIdEventoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ConviteInputInvalidoError(message);
      }

      span.setAttribute('evento.id', parsed.data.idEvento);

      const convite = await conviteRepository.findByIdEvento(parsed.data.idEvento);
      if (!convite) {
        throw new ConviteNaoEncontradoError(undefined, parsed.data.idEvento);
      }

      span.setAttribute('convite.id', convite.id);
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
