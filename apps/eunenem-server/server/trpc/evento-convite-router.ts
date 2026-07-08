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
  type IdCampanha,
  type IdCampanhaEvento,
  type IdConvite,
  type IdEvento,
  ImagemUrlConviteSchema,
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
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';

const t = initTRPC.context<TrpcContext>().create();

class CampanhaSlugNaoEncontradaError extends Error {
  public readonly name = 'CampanhaSlugNaoEncontradaError';
}

const ConviteSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{2,29}$/, 'Slug do convite invalido');

const EventoConvitePreviewInputSchema = z.object({
  slug: ConviteSlugSchema,
  // aperture-yeauv: OPTIONAL per-campanha routing on the PUBLIC preview hop.
  // Present → that campanha (owner-gated to the slug's conta); absent →
  // oldest campanha (back-compat).
  idCampanha: z.string().optional(),
});

/**
 * PUBLIC (no session) slug→campanha resolver for the preview hop.
 *
 * aperture-yeauv: OPTIONAL idCampanha. There is NO session here, so we do
 * NOT call the shared resolverCampanhaAdministrada. Instead, after resolving
 * the slug → usuario/conta:
 *   - idCampanha PRESENT → findById + verify the campanha belongs to the
 *     slug's conta (idsAdministradores includes usuario.idConta). Not-found
 *     AND not-owned collapse to the SAME non-leaking error.
 *   - idCampanha ABSENT → oldest campanha the slug's conta administers.
 */
async function resolveCampanhaBySlug(
  ctx: TrpcContext,
  slug: string,
  idCampanha?: string,
): Promise<{
  campanha: Campanha;
}> {
  const usuario = await ctx.deps.usuarioRepository.findUsuarioBySlug(
    ID_PLATAFORMA_EUNENEM,
    slug as never,
  );
  if (!usuario) {
    throw new CampanhaSlugNaoEncontradaError('Usuario do slug nao encontrado');
  }

  if (idCampanha !== undefined && idCampanha !== '') {
    const campanha = await ctx.deps.campanhaRepository.findById(idCampanha as IdCampanha);
    // Not-found AND not-owned-by-this-slug collapse to the same error.
    if (!campanha || !campanha.idsAdministradores.includes(usuario.idConta)) {
      throw new CampanhaSlugNaoEncontradaError('Campanha nao encontrada ou nao autorizada');
    }
    return { campanha };
  }

  const campanha = await ctx.deps.campanhaRepository.findByAdministrador(usuario.idConta);
  if (!campanha) {
    throw new CampanhaSlugNaoEncontradaError('Usuario do slug nao administra nenhuma campanha');
  }

  return { campanha };
}

async function resolveCallerCampanha(
  ctx: TrpcContext,
  idCampanha?: string,
): Promise<{
  campanha: Campanha;
}> {
  // aperture-yeauv: resolve via the shared per-campanha resolver. PRESENT
  // idCampanha → that campanha, owner-gated; ABSENT → oldest (back-compat).
  const { campanha } = await resolverCampanhaAdministrada(ctx, idCampanha);
  return { campanha };
}

const SaveEventoConviteInputSchema = z.object({
  // aperture-yeauv: OPTIONAL per-campanha routing. Absent → oldest campanha
  // (back-compat); present → that campanha, owner-gated.
  idCampanha: z.string().optional(),
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
  // aperture-j4zjw — custom-photo background. A real (uploaded) http(s) image
  // URL when the creator picks "usar uma foto sua"; null/absent for a watercolor
  // template or the plain scrapbook paper. Optional (nullish) so existing
  // callers that never set a photo stay valid. The domain use-cases already
  // accept imagemUrl; this wires it through the BFF save procedure.
  imagemUrl: ImagemUrlConviteSchema.nullish(),
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
  // aperture-yeauv: shared per-campanha resolver sentinels (authed hops).
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  if (err instanceof CampanhaInexistenteError) {
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
    .input(z.object({ idCampanha: z.string().optional() }).optional())
    .output(GetEventoConviteOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolveCallerCampanha(ctx, input?.idCampanha);
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
        const { campanha } = await resolveCampanhaBySlug(ctx, input.slug, input.idCampanha);
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
        const { campanha } = await resolveCallerCampanha(ctx, input.idCampanha);
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
                // aperture-j4zjw — a real URL sets/updates the photo; null/absent
                // leaves the existing value (the entity has no cleared state —
                // clearing a stale photo is a follow-up, see PR notes).
                imagemUrl: input.imagemUrl ?? undefined,
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
                // aperture-j4zjw — persist the custom-photo URL on first save.
                imagemUrl: input.imagemUrl ?? undefined,
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
