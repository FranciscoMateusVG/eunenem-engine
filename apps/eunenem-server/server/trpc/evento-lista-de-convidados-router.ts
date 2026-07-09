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
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';

const t = initTRPC.context<TrpcContext>().create();

class EventoAusenteError extends Error {
  public readonly name = 'EventoAusenteError';
}

class CampanhaSlugNaoEncontradaError extends Error {
  public readonly name = 'CampanhaSlugNaoEncontradaError';
}

// aperture-rvhlt: the old public resolveCampanhaBySlug (slug → OLDEST
// campanha) was removed — the public RSVP path now resolves convidado-first
// (see resolveConvidadoPublico) and no longer needs a slug→campanha hop.

async function resolveCallerCampanha(
  ctx: TrpcContext,
  idCampanha?: string,
): Promise<{ campanha: Campanha; usuario: Usuario }> {
  // aperture-yeauv: resolve via the shared per-campanha resolver. PRESENT
  // idCampanha → that campanha, owner-gated; ABSENT → oldest (back-compat).
  return resolverCampanhaAdministrada(ctx, idCampanha);
}

function toTRPCError(err: unknown): TRPCError {
  // aperture-yeauv: shared per-campanha resolver sentinels (authed hops).
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaInexistenteError) {
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
  // aperture-yeauv: OPTIONAL per-campanha routing (authed hop).
  idCampanha: z.string().optional(),
  idConvidado: z.string().uuid(),
  presenca: StatusPresencaConvidadoSchema,
});

const AdicionarConvidadoInputSchema = z.object({
  // aperture-yeauv: OPTIONAL per-campanha routing (authed hop).
  idCampanha: z.string().optional(),
  nome: NomeConvidadoSchema,
  numeroCelular: NumeroCelularConvidadoSchema,
});

/** Resolves a convidado from public route params (slug + idConvidado), with
 *  no session — used by the /confirmar-presenca page.
 *
 *  aperture-rvhlt (fblrt §3.3.1) — CONVIDADO-FIRST resolution. The old shape
 *  resolved slug → OLDEST campanha → evento → lista and then searched for the
 *  convidado, so a convidado on any NON-oldest campanha's lista was
 *  unreachable (guest RSVP for a 2nd campanha impossible). `idConvidado`
 *  (already in the guest URL) uniquely determines lista → evento → campanha
 *  via the convidados.lista_id FK + UNIQUE(id_campanha) chain, so we resolve
 *  FROM the convidado and use the slug ONLY as a validation cross-check: the
 *  resolved campanha must belong to the slug's conta, else the SAME
 *  NOT_FOUND a wrong/unknown convidado gets (no existence oracle). Zero URL
 *  changes — every existing guest link keeps working. */
async function resolveConvidadoPublico(
  ctx: TrpcContext,
  slug: string,
  idConvidado: string,
): Promise<{ lista: ListaDeConvidados; convidado: Convidado; idCampanha: string }> {
  const lista = await ctx.deps.listaDeConvidadosRepository.findByConvidadoId(
    idConvidado as IdConvidado,
  );
  if (!lista) {
    throw new ConvidadoNaoEncontradoError(idConvidado as IdConvidado);
  }

  const convidado = lista.convidados.find((c) => c.id === idConvidado);
  if (!convidado) {
    // Defensive — findByConvidadoId returned this lista BECAUSE it holds the
    // convidado; a miss here means a torn read. Same non-leaking error.
    throw new ConvidadoNaoEncontradoError(idConvidado as IdConvidado, lista.id);
  }

  // Slug cross-check: the convidado's campanha must belong to the slug's
  // conta. Wrong slug behaves EXACTLY like an unknown convidado (the old
  // behavior's posture, preserved).
  const evento = await ctx.deps.eventoRepository.findById(lista.idEvento);
  if (!evento) {
    throw new ListaDeConvidadosNaoEncontradaError();
  }
  const usuario = await ctx.deps.usuarioRepository.findUsuarioBySlug(
    ID_PLATAFORMA_EUNENEM,
    slug as never,
  );
  if (!usuario) {
    throw new CampanhaSlugNaoEncontradaError('Usuario do slug nao encontrado');
  }
  const campanha = await ctx.deps.campanhaRepository.findById(evento.idCampanha);
  if (!campanha || !campanha.idsAdministradores.includes(usuario.idConta)) {
    throw new ConvidadoNaoEncontradoError(idConvidado as IdConvidado, lista.id);
  }

  return { lista, convidado, idCampanha: evento.idCampanha };
}

const GetParaConfirmarInputSchema = z.object({
  slug: z.string(),
  idConvidado: z.string().uuid(),
});

const GetParaConfirmarOutputSchema = z.object({
  nome: z.string(),
  presenca: StatusPresencaConvidadoSchema,
  formatoMensagemConvite: FormatoMensagemConviteSchema,
  // fblrt amendment #3 (aphk8 bead): the convidado's campanha, so the RSVP
  // page can address eventoConvite.getPreview({slug, idCampanha}) at the
  // RIGHT campanha instead of defaulting to the oldest. Public UUID exposure
  // is already the norm (/pagina/:slug/c/:id). Additive — old clients ignore.
  idCampanha: z.string().uuid(),
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
    .input(z.object({ idCampanha: z.string().optional() }).optional())
    .output(GetListaDeConvidadosOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx, input?.idCampanha);
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
        const { campanha } = await resolveCallerCampanha(ctx, input.idCampanha);
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
        const { campanha } = await resolveCallerCampanha(ctx, input.idCampanha);
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
    .input(
      z.object({
        // aperture-yeauv: OPTIONAL per-campanha routing (authed hop).
        idCampanha: z.string().optional(),
        formatoMensagemConvite: FormatoMensagemConviteSchema,
      }),
    )
    .output(GetListaDeConvidadosOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx, input.idCampanha);
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
        const { convidado, lista, idCampanha } = await resolveConvidadoPublico(
          ctx,
          input.slug,
          input.idConvidado,
        );
        return {
          nome: convidado.nome,
          presenca: convidado.presenca,
          formatoMensagemConvite: lista.formatoMensagemConvite,
          idCampanha,
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
        const { lista, idCampanha } = await resolveConvidadoPublico(
          ctx,
          input.slug,
          input.idConvidado,
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

        const convidado = updated.convidados.find((c) => c.id === input.idConvidado);
        if (!convidado) {
          throw new ConvidadoNaoEncontradoError(input.idConvidado as IdConvidado, updated.id);
        }

        return {
          nome: convidado.nome,
          presenca: convidado.presenca,
          formatoMensagemConvite: updated.formatoMensagemConvite,
          idCampanha,
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

export type EventoListaDeConvidadosRouter = typeof eventoListaDeConvidadosRouter;
