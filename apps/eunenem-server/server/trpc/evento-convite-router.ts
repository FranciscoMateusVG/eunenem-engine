import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  atualizarConvite,
  atualizarEvento,
  type Campanha,
  ConviteInputInvalidoError,
  ConviteNaoEncontradoError,
  criarConvite,
  criarEvento,
  EventoCampanhaJaTemEventoError,
  EventoInputInvalidoError,
  EventoNaoEncontradoError,
  FonteConviteSchema,
  ID_PLATAFORMA_EUNENEM,
  type IdCampanhaEvento,
  type IdConvite,
  type IdEvento,
  MensagemConviteSchema,
  ModeloConviteSchema,
  ModalidadeEventoSchema,
  NomeExibidoConviteSchema,
  obterConvitePorIdEvento,
  obterEventoPorIdCampanha,
  PaletaConviteSchema,
  RemetenteConviteSchema,
  TipoEventoSchema,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

class SessaoAusenteError extends Error {
  public readonly name = 'SessaoAusenteError';
}

class CampanhaAusenteError extends Error {
  public readonly name = 'CampanhaAusenteError';
}

class CampanhaSlugNaoEncontradaError extends Error {
  public readonly name = 'CampanhaSlugNaoEncontradaError';
}

function readSessionCookie(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const target = `${name}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(target)) {
      return decodeURIComponent(cookie.slice(target.length));
    }
  }
  return null;
}

const ConviteSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{2,29}$/, 'Slug do convite invalido');

const EventoConvitePreviewInputSchema = z.object({
  slug: ConviteSlugSchema,
});

async function resolveCampanhaBySlug(ctx: TrpcContext, slug: string): Promise<{
  campanha: Campanha;
}> {
  const usuario = await ctx.deps.usuarioRepository.findUsuarioBySlug(
    ID_PLATAFORMA_EUNENEM,
    slug as never,
  );
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
): Promise<{
  campanha: Campanha;
}> {
  const { deps, headers } = ctx;
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (!token) {
    throw new SessaoAusenteError('Sessao ausente');
  }

  let sessao;
  try {
    sessao = await deps.authService.validarSessao(token);
  } catch {
    throw new SessaoAusenteError('Sessao invalida');
  }
  if (!sessao) {
    throw new SessaoAusenteError('Sessao expirada');
  }

  const usuario = await deps.usuarioRepository.findUsuarioById(sessao.idUsuario);
  if (!usuario) {
    throw new SessaoAusenteError('Usuario nao encontrado');
  }

  const campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new CampanhaAusenteError('Usuario nao administra nenhuma campanha');
  }

  return { campanha };
}

const SaveEventoConviteInputSchema = z.object({
  tipoEvento: TipoEventoSchema,
  modalidade: ModalidadeEventoSchema,
  dataHoraIso: z.string().datetime(),
  endereco: z.string().trim().min(1).max(500).nullable(),
  remetente: RemetenteConviteSchema,
  nomeExibido: NomeExibidoConviteSchema,
  mensagem: MensagemConviteSchema,
  paleta: PaletaConviteSchema,
  fonte: FonteConviteSchema,
  modelo: ModeloConviteSchema,
});

const EventoSnapshotSchema = z.object({
  id: z.string().uuid(),
  tipoEvento: TipoEventoSchema,
  modalidade: ModalidadeEventoSchema,
  dataHoraIso: z.string().datetime(),
  endereco: z.string().nullable(),
});

const ConviteSnapshotSchema = z.object({
  id: z.string().uuid(),
  remetente: RemetenteConviteSchema,
  nomeExibido: NomeExibidoConviteSchema,
  mensagem: MensagemConviteSchema,
  paleta: PaletaConviteSchema,
  fonte: FonteConviteSchema,
  modelo: ModeloConviteSchema,
  imagemUrl: z.string().nullable(),
});

const GetEventoConviteOutputSchema = z.object({
  evento: EventoSnapshotSchema.nullable(),
  convite: ConviteSnapshotSchema.nullable(),
});

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof SessaoAusenteError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaAusenteError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof CampanhaSlugNaoEncontradaError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof EventoInputInvalidoError || err instanceof ConviteInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof EventoNaoEncontradoError || err instanceof ConviteNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof EventoCampanhaJaTemEventoError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

function toDate(dataHoraIso: string): Date {
  return new Date(dataHoraIso);
}

async function loadEventoConviteSnapshot(
  ctx: TrpcContext,
  campanha: Campanha,
): Promise<z.infer<typeof GetEventoConviteOutputSchema>> {
  let evento: Awaited<ReturnType<typeof obterEventoPorIdCampanha>> | null = null;
  try {
    evento = await obterEventoPorIdCampanha(
      {
        eventoRepository: ctx.deps.eventoRepository,
        observability: ctx.deps.observability,
      },
      { idCampanha: campanha.id as IdCampanhaEvento },
    );
  } catch (err) {
    if (!(err instanceof EventoNaoEncontradoError)) {
      throw err;
    }
  }

  if (!evento) {
    return {
      evento: null,
      convite: null,
    };
  }

  let convite: Awaited<ReturnType<typeof obterConvitePorIdEvento>> | null = null;
  try {
    convite = await obterConvitePorIdEvento(
      {
        conviteRepository: ctx.deps.conviteRepository,
        observability: ctx.deps.observability,
      },
      { idEvento: evento.id as IdEvento },
    );
  } catch (err) {
    if (!(err instanceof ConviteNaoEncontradoError)) {
      throw err;
    }
  }

  return {
    evento: {
      id: evento.id,
      tipoEvento: evento.tipoEvento,
      modalidade: evento.modalidade,
      dataHoraIso: evento.dataHora.toISOString(),
      endereco: evento.endereco,
    },
    convite: convite
      ? {
          id: convite.id,
          remetente: convite.remetente,
          nomeExibido: convite.nomeExibido,
          mensagem: convite.mensagem,
          paleta: convite.paleta,
          fonte: convite.fonte,
          modelo: convite.modelo,
          imagemUrl: convite.imagemUrl ?? null,
        }
      : null,
  };
}

export const eventoConviteRouter = t.router({
  get: t.procedure
    .output(GetEventoConviteOutputSchema)
    .query(async ({ ctx }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        return loadEventoConviteSnapshot(ctx, campanha);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  getPreview: t.procedure
    .input(EventoConvitePreviewInputSchema)
    .output(GetEventoConviteOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCampanhaBySlug(ctx, input.slug);
        return loadEventoConviteSnapshot(ctx, campanha);
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  save: t.procedure
    .input(SaveEventoConviteInputSchema)
    .output(GetEventoConviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx);
        const existingEvento = await ctx.deps.eventoRepository.findByIdCampanha(
          campanha.id as IdCampanhaEvento,
        );

        const evento = existingEvento
          ? await atualizarEvento(
              {
                eventoRepository: ctx.deps.eventoRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: existingEvento.id,
                tipoEvento: input.tipoEvento,
                modalidade: input.modalidade,
                dataHora: toDate(input.dataHoraIso),
                endereco: input.endereco,
              },
            )
          : await criarEvento(
              {
                eventoRepository: ctx.deps.eventoRepository,
                campanhaRepository: ctx.deps.campanhaRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: randomUUID() as IdEvento,
                idCampanha: campanha.id as IdCampanhaEvento,
                tipoEvento: input.tipoEvento,
                modalidade: input.modalidade,
                dataHora: toDate(input.dataHoraIso),
                endereco: input.endereco,
              },
            );

        const existingConvite = await ctx.deps.conviteRepository.findByIdEvento(evento.id);
        const convite = existingConvite
          ? await atualizarConvite(
              {
                conviteRepository: ctx.deps.conviteRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: existingConvite.id,
                remetente: input.remetente,
                nomeExibido: input.nomeExibido,
                mensagem: input.mensagem,
                paleta: input.paleta,
                fonte: input.fonte,
                modelo: input.modelo,
              },
            )
          : await criarConvite(
              {
                conviteRepository: ctx.deps.conviteRepository,
                eventoRepository: ctx.deps.eventoRepository,
                clock: ctx.deps.clock,
                observability: ctx.deps.observability,
              },
              {
                id: randomUUID() as IdConvite,
                idEvento: evento.id,
                remetente: input.remetente,
                nomeExibido: input.nomeExibido,
                mensagem: input.mensagem,
                paleta: input.paleta,
                fonte: input.fonte,
                modelo: input.modelo,
              },
            );

        return {
          evento: {
            id: evento.id,
            tipoEvento: evento.tipoEvento,
            modalidade: evento.modalidade,
            dataHoraIso: evento.dataHora.toISOString(),
            endereco: evento.endereco,
          },
          convite: {
            id: convite.id,
            remetente: convite.remetente,
            nomeExibido: convite.nomeExibido,
            mensagem: convite.mensagem,
            paleta: convite.paleta,
            fonte: convite.fonte,
            modelo: convite.modelo,
            imagemUrl: convite.imagemUrl ?? null,
          },
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

export type EventoConviteRouter = typeof eventoConviteRouter;
