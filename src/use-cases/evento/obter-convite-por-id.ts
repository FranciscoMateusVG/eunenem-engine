import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ConviteRepository } from '../../adapters/evento/convite-repository.js';
import type { Convite } from '../../domain/evento/entities/convite.js';
import { IdConviteSchema } from '../../domain/evento/value-objects/ids.js';
import { ConviteInputInvalidoError } from '../../errors/evento/convite-input-invalido.error.js';
import { ConviteNaoEncontradoError } from '../../errors/evento/convite-nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterConvitePorIdInputSchema = z.object({
  id: IdConviteSchema,
});

export type ObterConvitePorIdInput = z.infer<typeof ObterConvitePorIdInputSchema>;

export interface ObterConvitePorIdDeps {
  readonly conviteRepository: ConviteRepository;
  readonly observability: Observability;
}

export async function obterConvitePorId(
  deps: ObterConvitePorIdDeps,
  input: ObterConvitePorIdInput,
): Promise<Convite> {
  const { conviteRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterConvitePorId', async (span) => {
    try {
      const parsed = ObterConvitePorIdInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ConviteInputInvalidoError(message);
      }

      span.setAttribute('convite.id', parsed.data.id);

      const convite = await conviteRepository.findById(parsed.data.id);
      if (!convite) {
        throw new ConviteNaoEncontradoError(parsed.data.id);
      }

      span.setAttribute('evento.id', convite.idEvento);
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
