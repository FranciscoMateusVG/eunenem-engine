import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ListaDeConvidadosRepository } from '../../adapters/evento/lista-de-convidados-repository.js';
import type { ListaDeConvidados } from '../../domain/evento/entities/lista-de-convidados.js';
import { IdListaDeConvidadosSchema } from '../../domain/evento/value-objects/ids.js';
import { ListaDeConvidadosInputInvalidoError } from '../../errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosNaoEncontradaError } from '../../errors/evento/lista-de-convidados-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

export const ObterListaDeConvidadosPorIdInputSchema = z.object({
  id: IdListaDeConvidadosSchema,
});

export type ObterListaDeConvidadosPorIdInput = z.infer<
  typeof ObterListaDeConvidadosPorIdInputSchema
>;

export interface ObterListaDeConvidadosPorIdDeps {
  readonly listaDeConvidadosRepository: ListaDeConvidadosRepository;
  readonly observability: Observability;
}

export async function obterListaDeConvidadosPorId(
  deps: ObterListaDeConvidadosPorIdDeps,
  input: ObterListaDeConvidadosPorIdInput,
): Promise<ListaDeConvidados> {
  const { listaDeConvidadosRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterListaDeConvidadosPorId', async (span) => {
    try {
      const parsed = ObterListaDeConvidadosPorIdInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new ListaDeConvidadosInputInvalidoError(message);
      }

      span.setAttribute('listaDeConvidados.id', parsed.data.id);

      const lista = await listaDeConvidadosRepository.findById(parsed.data.id);
      if (!lista) {
        throw new ListaDeConvidadosNaoEncontradaError(parsed.data.id);
      }

      span.setAttribute('evento.id', lista.idEvento);
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
