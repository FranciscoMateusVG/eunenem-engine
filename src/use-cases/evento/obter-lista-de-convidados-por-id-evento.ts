import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ListaDeConvidadosRepository } from '../../adapters/evento/lista-de-convidados-repository.js';
import type { ListaDeConvidados } from '../../domain/evento/entities/lista-de-convidados.js';
import { IdEventoSchema } from '../../domain/evento/value-objects/ids.js';
import { ListaDeConvidadosInputInvalidoError } from '../../errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosNaoEncontradaError } from '../../errors/evento/lista-de-convidados-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterListaDeConvidadosPorIdEventoInputSchema = z.object({
  idEvento: IdEventoSchema,
});

export type ObterListaDeConvidadosPorIdEventoInput = z.infer<
  typeof ObterListaDeConvidadosPorIdEventoInputSchema
>;

export interface ObterListaDeConvidadosPorIdEventoDeps {
  readonly listaDeConvidadosRepository: ListaDeConvidadosRepository;
  readonly observability: Observability;
}

export async function obterListaDeConvidadosPorIdEvento(
  deps: ObterListaDeConvidadosPorIdEventoDeps,
  input: ObterListaDeConvidadosPorIdEventoInput,
): Promise<ListaDeConvidados> {
  const { listaDeConvidadosRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterListaDeConvidadosPorIdEvento', async (span) => {
    try {
      const parsed = ObterListaDeConvidadosPorIdEventoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new ListaDeConvidadosInputInvalidoError(message);
      }

      span.setAttribute('evento.id', parsed.data.idEvento);

      const lista = await listaDeConvidadosRepository.findByIdEvento(parsed.data.idEvento);
      if (!lista) {
        throw new ListaDeConvidadosNaoEncontradaError(undefined, parsed.data.idEvento);
      }

      span.setAttribute('listaDeConvidados.id', lista.id);
      span.setStatus({ code: SpanStatusCode.OK });
      return lista;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
