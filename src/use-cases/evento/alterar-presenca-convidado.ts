import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ListaDeConvidadosRepository } from '../../adapters/evento/lista-de-convidados-repository.js';
import type { ListaDeConvidados } from '../../domain/evento/entities/lista-de-convidados.js';
import {
  IdConvidadoSchema,
  IdListaDeConvidadosSchema,
} from '../../domain/evento/value-objects/ids.js';
import { StatusPresencaConvidadoSchema } from '../../domain/evento/value-objects/status-presenca-convidado.js';
import { ConvidadoNaoEncontradoError } from '../../errors/evento/convidado-nao-encontrado.error.js';
import { ListaDeConvidadosInputInvalidoError } from '../../errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosNaoEncontradaError } from '../../errors/evento/lista-de-convidados-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export const AlterarPresencaConvidadoInputSchema = z.object({
  idListaDeConvidados: IdListaDeConvidadosSchema,
  idConvidado: IdConvidadoSchema,
  presenca: StatusPresencaConvidadoSchema,
});

export type AlterarPresencaConvidadoInput = z.infer<typeof AlterarPresencaConvidadoInputSchema>;

export interface AlterarPresencaConvidadoDeps {
  readonly listaDeConvidadosRepository: ListaDeConvidadosRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function alterarPresencaConvidado(
  deps: AlterarPresencaConvidadoDeps,
  input: AlterarPresencaConvidadoInput,
): Promise<ListaDeConvidados> {
  const { listaDeConvidadosRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('alterarPresencaConvidado', async (span) => {
    try {
      const parsed = AlterarPresencaConvidadoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new ListaDeConvidadosInputInvalidoError(message);
      }

      span.setAttribute('listaDeConvidados.id', parsed.data.idListaDeConvidados);
      span.setAttribute('convidado.id', parsed.data.idConvidado);
      span.setAttribute('convidado.presenca', parsed.data.presenca);

      const existing = await listaDeConvidadosRepository.findById(parsed.data.idListaDeConvidados);
      if (!existing) {
        throw new ListaDeConvidadosNaoEncontradaError(parsed.data.idListaDeConvidados);
      }

      const convidado = existing.convidados.find((item) => item.id === parsed.data.idConvidado);
      if (!convidado) {
        throw new ConvidadoNaoEncontradoError(
          parsed.data.idConvidado,
          parsed.data.idListaDeConvidados,
        );
      }

      const updated = await listaDeConvidadosRepository.alterarPresencaConvidado(
        parsed.data.idListaDeConvidados,
        parsed.data.idConvidado,
        parsed.data.presenca,
        clock(),
      );

      if (!updated) {
        throw new ListaDeConvidadosNaoEncontradaError(parsed.data.idListaDeConvidados);
      }

      logger.info('listaDeConvidados.presencaConvidadoAlterada', {
        idListaDeConvidados: updated.id,
        idEvento: updated.idEvento,
        idConvidado: parsed.data.idConvidado,
        presenca: parsed.data.presenca,
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
