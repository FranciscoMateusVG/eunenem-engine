import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  alterarPresencaConvidado,
  atualizarListaDeConvidados,
  type Campanha,
  type Convidado,
  ConvidadoNaoEncontradoError,
  criarListaDeConvidados,
  EventoNaoEncontradoError,
  FormatoMensagemConviteSchema,
  ID_PLATAFORMA_EUNENEM,
  type IdCampanhaEvento,
  type IdConvidado,
  type IdEvento,
  type IdListaDeConvidados,
  ListaDeConvidadosInputInvalidoError,
  ListaDeConvidadosJaExisteError,
  ListaDeConvidadosNaoEncontradaError,
  type ListaDeConvidados,
  NomeConvidadoSchema,
  NumeroCelularConvidadoSchema,
  obterEventoPorIdCampanha,
  obterListaDeConvidadosPorIdEvento,
  StatusPresencaConvidadoSchema,
  type Usuario,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

class SessaoAusenteError extends Error {
  public readonly name = 'SessaoAusenteError';
}

class CampanhaAusenteError extends Error {
  public readonly name = 'CampanhaAusenteError';
}

class EventoAusenteError extends Error {
  public readonly name = 'EventoAusenteError';
}

class CampanhaSlugNaoEncontradaError extends Error {
  public readonly name = 'CampanhaSlugNaoEncontradaError';
}

/** Public resolver — no session required. Mirrors evento-convite-router's
 *  resolveCampanhaBySlug (used by the public confirmar-presenca page). */
async function resolveCampanhaBySlug(ctx: TrpcContext, slug: string): Promise<{ campanha: Campanha }> {
  const usuario = await ctx.deps.usuarioRepository.findUsuarioBySlug(ID_PLATAFORMA_EUNENEM, slug as never);
  if (!usuario) {
    throw new CampanhaSlugNaoEncontradaError('Usuario do slug nao encontrado');
  }

  const campanha = await ctx.deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new CampanhaSlugNaoEncontradaError('Usuario do slug nao administra nenhuma campanha');
  }

  return { campanha };
}

async function resolveCallerCampanha(
  ctx: TrpcContext,
): Promise<{ campanha: Campanha; usuario: Usuario }> {
  const { deps, headers } = ctx;
  let usuario: Usuario;
  try {
    usuario = (await resolverUsuarioAutenticado(deps, headers)).usuario;
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) {
      throw new SessaoAusenteError('Sessao invalida');
    }
    throw err;
  }

  const campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new CampanhaAusenteError('Usuario nao administra nenhuma campanha');
  }

  return { campanha, usuario };
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof SessaoAusenteError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaAusenteError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
  }
  if (err instanceof EventoAusenteError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaSlugNaoEncontradaError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ListaDeConvidadosInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (
    err instanceof ListaDeConvidadosNaoEncontradaError ||
    err instanceof ConvidadoNaoEncontradoError
  ) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof ListaDeConvidadosJaExisteError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

const ConvidadoSnapshotSchema = z.object({
  id: z.string().uuid(),
  nome: z.string(),
  numeroCelular: z.string(),
  presenca: StatusPresencaConvidadoSchema,
});

const ListaDeConvidadosSnapshotSchema = z.object({
  id: z.string().uuid(),
  linkConfirmacao: z.string(),
  formatoMensagemConvite: FormatoMensagemConviteSchema,
  convidados: z.array(ConvidadoSnapshotSchema),
});

const GetListaDeConvidadosOutputSchema = z.object({
  lista: ListaDeConvidadosSnapshotSchema.nullable(),
});

function toSnapshot(
  lista: ListaDeConvidados,
): z.infer<typeof GetListaDeConvidadosOutputSchema> {
  return {
    lista: {
      id: lista.id,
      linkConfirmacao: lista.linkConfirmacao,
      formatoMensagemConvite: lista.formatoMensagemConvite,
      convidados: lista.convidados.map((convidado) => ({
        id: convidado.id,
        nome: convidado.nome,
        numeroCelular: convidado.numeroCelular,
        presenca: convidado.presenca,
      })),
    },
  };
}

/** Resolves the caller's evento, or `null` if they haven't created one yet. */
async function resolveCallerEvento(
  ctx: TrpcContext,
  campanha: Campanha,
): Promise<Awaited<ReturnType<typeof obterEventoPorIdCampanha>> | null> {
  try {
    return await obterEventoPorIdCampanha(
      { eventoRepository: ctx.deps.eventoRepository, observability: ctx.deps.observability },
      { idCampanha: campanha.id as IdCampanhaEvento },
    );
  } catch (err) {
    if (err instanceof EventoNaoEncontradoError) {
      return null;
    }
    throw err;
  }
}

async function loadListaSnapshot(
  ctx: TrpcContext,
  idEvento: IdEvento,
): Promise<z.infer<typeof GetListaDeConvidadosOutputSchema>> {
  try {
    const lista = await obterListaDeConvidadosPorIdEvento(
      {
        listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
        observability: ctx.deps.observability,
      },
      { idEvento },
    );
    return toSnapshot(lista);
  } catch (err) {
    if (err instanceof ListaDeConvidadosNaoEncontradaError) {
      return { lista: null };
    }
    throw err;
  }
}

const AlterarPresencaInputSchema = z.object({
  idConvidado: z.string().uuid(),
  presenca: StatusPresencaConvidadoSchema,
});

const AdicionarConvidadoInputSchema = z.object({
  nome: NomeConvidadoSchema,
  numeroCelular: NumeroCelularConvidadoSchema,
});

/** Resolves a convidado from public route params (slug + idConvidado), with
 *  no session — used by the /confirmar-presenca page. Verifies the convidado
 *  actually belongs to that slug's evento/lista before returning it. */
async function resolveConvidadoPublico(
  ctx: TrpcContext,
  slug: string,
  idConvidado: string,
): Promise<{ lista: ListaDeConvidados; convidado: Convidado }> {
  const { campanha } = await resolveCampanhaBySlug(ctx, slug);
  const evento = await resolveCallerEvento(ctx, campanha);
  if (!evento) {
    throw new ListaDeConvidadosNaoEncontradaError();
  }

  const lista = await obterListaDeConvidadosPorIdEvento(
    {
      listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
      observability: ctx.deps.observability,
    },
    { idEvento: evento.id as IdEvento },
  );

  const convidado = lista.convidados.find((c) => c.id === idConvidado);
  if (!convidado) {
    throw new ConvidadoNaoEncontradoError(idConvidado as IdConvidado, lista.id);
  }

  return { lista, convidado };
}

const GetParaConfirmarInputSchema = z.object({
  slug: z.string(),
  idConvidado: z.string().uuid(),
});

const GetParaConfirmarOutputSchema = z.object({
  nome: z.string(),
  presenca: StatusPresencaConvidadoSchema,
  formatoMensagemConvite: FormatoMensagemConviteSchema,
});

/** Public guests may only set one of the 3 final responses — nao_enviado/
 *  enviado are governed by the authenticated send flow, never by the guest. */
const ConfirmarPresencaInputSchema = z.object({
  slug: z.string(),
  idConvidado: z.string().uuid(),
  presenca: z.enum(['sim', 'nao', 'talvez']),
});

export const eventoListaDeConvidadosRouter = t.router({
  get: t.procedure
    .output(GetListaDeConvidadosOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        const evento = await resolveCallerEvento(ctx, campanha);
        if (!evento) {
          return { lista: null };
        }
        return await loadListaSnapshot(ctx, evento.id as IdEvento);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  alterarPresenca: t.procedure
    .input(AlterarPresencaInputSchema)
    .output(GetListaDeConvidadosOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        const evento = await resolveCallerEvento(ctx, campanha);
        if (!evento) {
          throw new ListaDeConvidadosNaoEncontradaError();
        }

        const lista = await obterListaDeConvidadosPorIdEvento(
          {
            listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
            observability: ctx.deps.observability,
          },
          { idEvento: evento.id as IdEvento },
        );

        const updated = await alterarPresencaConvidado(
          {
            listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idListaDeConvidados: lista.id,
            idConvidado: input.idConvidado as IdConvidado,
            presenca: input.presenca,
          },
        );

        return toSnapshot(updated);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  adicionarConvidado: t.procedure
    .input(AdicionarConvidadoInputSchema)
    .output(GetListaDeConvidadosOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha, usuario } = await resolveCallerCampanha(ctx);
        const evento = await resolveCallerEvento(ctx, campanha);
        if (!evento) {
          throw new EventoAusenteError('Crie seu convite antes de adicionar convidados');
        }

        const novoConvidado: Convidado = {
          id: randomUUID() as IdConvidado,
          nome: input.nome,
          numeroCelular: input.numeroCelular,
          presenca: 'nao_enviado',
        };

        const existing = await ctx.deps.listaDeConvidadosRepository.findByIdEvento(
          evento.id as IdEvento,
        );

        const updated = existing
          ? await atualizarListaDeConvidados(
              {
                listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: existing.id,
                linkConfirmacao: existing.linkConfirmacao,
                formatoMensagemConvite: existing.formatoMensagemConvite,
                convidados: [...existing.convidados, novoConvidado],
              },
            )
          : await criarListaDeConvidados(
              {
                listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
                eventoRepository: ctx.deps.eventoRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: randomUUID() as IdListaDeConvidados,
                idEvento: evento.id as IdEvento,
                linkConfirmacao: new URL(
                  `/confirmar/${usuario.slug}`,
                  ctx.deps.publicOrigin,
                ).toString(),
                formatoMensagemConvite: 'texto',
                convidados: [novoConvidado],
              },
            );

        return toSnapshot(updated);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  salvarFormatoMensagem: t.procedure
    .input(z.object({ formatoMensagemConvite: FormatoMensagemConviteSchema }))
    .output(GetListaDeConvidadosOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha, usuario } = await resolveCallerCampanha(ctx);
        const evento = await resolveCallerEvento(ctx, campanha);
        if (!evento) {
          throw new EventoAusenteError('Crie seu convite antes de escolher o formato da mensagem');
        }

        const existing = await ctx.deps.listaDeConvidadosRepository.findByIdEvento(
          evento.id as IdEvento,
        );

        const updated = existing
          ? await atualizarListaDeConvidados(
              {
                listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: existing.id,
                linkConfirmacao: existing.linkConfirmacao,
                formatoMensagemConvite: input.formatoMensagemConvite,
                convidados: [...existing.convidados],
              },
            )
          : await criarListaDeConvidados(
              {
                listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
                eventoRepository: ctx.deps.eventoRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: randomUUID() as IdListaDeConvidados,
                idEvento: evento.id as IdEvento,
                linkConfirmacao: new URL(
                  `/confirmar/${usuario.slug}`,
                  ctx.deps.publicOrigin,
                ).toString(),
                formatoMensagemConvite: input.formatoMensagemConvite,
                convidados: [],
              },
            );

        return toSnapshot(updated);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  // ── Public procedures (no session) — /confirmar-presenca page ──────────

  getParaConfirmar: t.procedure
    .input(GetParaConfirmarInputSchema)
    .output(GetParaConfirmarOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { convidado, lista } = await resolveConvidadoPublico(
          ctx,
          input.slug,
          input.idConvidado,
        );
        return {
          nome: convidado.nome,
          presenca: convidado.presenca,
          formatoMensagemConvite: lista.formatoMensagemConvite,
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  confirmarPresenca: t.procedure
    .input(ConfirmarPresencaInputSchema)
    .output(GetParaConfirmarOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { lista } = await resolveConvidadoPublico(ctx, input.slug, input.idConvidado);

        const updated = await alterarPresencaConvidado(
          {
            listaDeConvidadosRepository: ctx.deps.listaDeConvidadosRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idListaDeConvidados: lista.id,
            idConvidado: input.idConvidado as IdConvidado,
            presenca: input.presenca,
          },
        );

        const convidado = updated.convidados.find((c) => c.id === input.idConvidado);
        if (!convidado) {
          throw new ConvidadoNaoEncontradoError(input.idConvidado as IdConvidado, updated.id);
        }

        return {
          nome: convidado.nome,
          presenca: convidado.presenca,
          formatoMensagemConvite: updated.formatoMensagemConvite,
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

export type EventoListaDeConvidadosRouter = typeof eventoListaDeConvidadosRouter;
