import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { EventoRepository } from '../../adapters/evento/evento-repository.js';
import type { ListaDeConvidadosRepository } from '../../adapters/evento/lista-de-convidados-repository.js';
import {
  criarListaDeConvidados as criarListaDeConvidadosDominio,
  type ListaDeConvidados,
} from '../../domain/evento/entities/lista-de-convidados.js';
import {
  IdConvidadoSchema,
  IdEventoSchema,
  IdListaDeConvidadosSchema,
} from '../../domain/evento/value-objects/ids.js';
import { LinkConfirmacaoSchema } from '../../domain/evento/value-objects/link-confirmacao-lista.js';
import { NomeConvidadoSchema } from '../../domain/evento/value-objects/nome-convidado.js';
import { NumeroCelularConvidadoSchema } from '../../domain/evento/value-objects/numero-celular-convidado.js';
import { StatusPresencaConvidadoSchema } from '../../domain/evento/value-objects/status-presenca-convidado.js';
import { ListaDeConvidadosInputInvalidoError } from '../../errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosJaExisteError } from '../../errors/evento/lista-de-convidados-ja-existe.error.js';
import { EventoNaoEncontradoError } from '../../errors/evento/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

const ConvidadoInputSchema = z.object({
  id: IdConvidadoSchema,
  nome: NomeConvidadoSchema,
  numeroCelular: NumeroCelularConvidadoSchema,
  presenca: StatusPresencaConvidadoSchema,
});

export const CriarListaDeConvidadosInputSchema = z.object({
  id: IdListaDeConvidadosSchema,
  idEvento: IdEventoSchema,
  linkConfirmacao: LinkConfirmacaoSchema,
  convidados: z.array(ConvidadoInputSchema),
});

export type CriarListaDeConvidadosInput = z.infer<typeof CriarListaDeConvidadosInputSchema>;

export interface CriarListaDeConvidadosDeps {
  readonly listaDeConvidadosRepository: ListaDeConvidadosRepository;
  readonly eventoRepository: EventoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function criarListaDeConvidados(
  deps: CriarListaDeConvidadosDeps,
  input: CriarListaDeConvidadosInput,
): Promise<ListaDeConvidados> {
  const { listaDeConvidadosRepository, eventoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarListaDeConvidados', async (span) => {
    try {
      const parsed = CriarListaDeConvidadosInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new ListaDeConvidadosInputInvalidoError(message);
      }

      const now = clock();
      span.setAttribute('listaDeConvidados.id', parsed.data.id);
      span.setAttribute('evento.id', parsed.data.idEvento);
      span.setAttribute('listaDeConvidados.totalConvidados', parsed.data.convidados.length);

      const evento = await eventoRepository.findById(parsed.data.idEvento);
      if (!evento) {
        throw new EventoNaoEncontradoError(parsed.data.idEvento);
      }

      const existing = await listaDeConvidadosRepository.findByIdEvento(parsed.data.idEvento);
      if (existing) {
        throw new ListaDeConvidadosJaExisteError(parsed.data.idEvento);
      }

      const listaDeConvidados = criarListaDeConvidadosDominio({
        id: parsed.data.id,
        idEvento: parsed.data.idEvento,
        linkConfirmacao: parsed.data.linkConfirmacao,
        convidados: parsed.data.convidados,
        criadoEm: now,
        atualizadoEm: now,
      });

      await listaDeConvidadosRepository.save(listaDeConvidados);

      logger.info('listaDeConvidados.criada', {
        idListaDeConvidados: listaDeConvidados.id,
        idEvento: listaDeConvidados.idEvento,
        totalConvidados: listaDeConvidados.convidados.length,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return listaDeConvidados;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
