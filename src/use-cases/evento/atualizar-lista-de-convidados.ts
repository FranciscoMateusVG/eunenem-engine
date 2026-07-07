import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ListaDeConvidadosRepository } from '../../adapters/evento/lista-de-convidados-repository.js';
import {
  type ListaDeConvidados,
  listaDeConvidadosComCamposAtualizados,
} from '../../domain/evento/entities/lista-de-convidados.js';
import { FormatoMensagemConviteSchema } from '../../domain/evento/value-objects/formato-mensagem-convite.js';
import {
  IdConvidadoSchema,
  IdListaDeConvidadosSchema,
} from '../../domain/evento/value-objects/ids.js';
import { NomeConvidadoSchema } from '../../domain/evento/value-objects/nome-convidado.js';
import { NumeroCelularConvidadoSchema } from '../../domain/evento/value-objects/numero-celular-convidado.js';
import { StatusPresencaConvidadoSchema } from '../../domain/evento/value-objects/status-presenca-convidado.js';
import { ListaDeConvidadosInputInvalidoError } from '../../errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosNaoEncontradaError } from '../../errors/evento/lista-de-convidados-nao-encontrada.error.js';
import type { Observability } from '../../observability/observability.js';

const ConvidadoInputSchema = z.object({
  id: IdConvidadoSchema,
  nome: NomeConvidadoSchema,
  numeroCelular: NumeroCelularConvidadoSchema,
  presenca: StatusPresencaConvidadoSchema,
});

export const AtualizarListaDeConvidadosInputSchema = z.object({
  id: IdListaDeConvidadosSchema,
  formatoMensagemConvite: FormatoMensagemConviteSchema,
  convidados: z.array(ConvidadoInputSchema),
});

export type AtualizarListaDeConvidadosInput = z.infer<typeof AtualizarListaDeConvidadosInputSchema>;

export interface AtualizarListaDeConvidadosDeps {
  readonly listaDeConvidadosRepository: ListaDeConvidadosRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function atualizarListaDeConvidados(
  deps: AtualizarListaDeConvidadosDeps,
  input: AtualizarListaDeConvidadosInput,
): Promise<ListaDeConvidados> {
  const { listaDeConvidadosRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('atualizarListaDeConvidados', async (span) => {
    try {
      const parsed = AtualizarListaDeConvidadosInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new ListaDeConvidadosInputInvalidoError(message);
      }

      span.setAttribute('listaDeConvidados.id', parsed.data.id);
      span.setAttribute('listaDeConvidados.totalConvidados', parsed.data.convidados.length);

      const existing = await listaDeConvidadosRepository.findById(parsed.data.id);
      if (!existing) {
        throw new ListaDeConvidadosNaoEncontradaError(parsed.data.id);
      }

      const updated = listaDeConvidadosComCamposAtualizados(
        existing,
        {
          formatoMensagemConvite: parsed.data.formatoMensagemConvite,
          convidados: parsed.data.convidados,
        },
        clock(),
      );

      await listaDeConvidadosRepository.save(updated);

      logger.info('listaDeConvidados.atualizada', {
        idListaDeConvidados: updated.id,
        idEvento: updated.idEvento,
        totalConvidados: updated.convidados.length,
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
