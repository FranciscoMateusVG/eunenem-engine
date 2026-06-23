/**
 * Perfil tRPC router (aperture-cdo69) — exposes the PerfilCriador aggregate.
 *
 * Procedures:
 *   - `perfil.atualizar`            mutation, AUTHED  → PerfilProprioDTO
 *   - `perfil.getPerfil`            query,    AUTHED  → PerfilProprioDTO
 *   - `perfil.getPerfilPublicoBySlug` query,  PUBLIC  → PerfilPublicoDTO
 *
 * Authed procedures derive `idUsuario` from the session cookie; the client
 * NEVER sends it (no "edit someone else's profile" shape). The public
 * procedure resolves `(ID_PLATAFORMA_EUNENEM, slug)` → Usuario → profile and
 * returns the PII-safe `PerfilPublicoDTO` only — same tenant-resolution chain
 * as `pagina-router`.
 */
import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  atualizarPerfilCriador,
  atualizarPerfilUsuario,
  EmitirUrlUploadFotoInputSchema,
  emitirUrlUploadFoto,
  type IdPerfilCriador,
  type IdUsuario,
  obterPerfilCriador,
  obterPerfilPublicoBySlug,
  PerfilProprioDTOSchema,
  PerfilPublicoDTOSchema,
  type SlugUsuario,
  TipoEventoPerfilSchema,
  UsuarioInputInvalidoError,
  UsuarioNaoEncontradoError,
} from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

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

async function resolveCallerIdUsuario(ctx: TrpcContext): Promise<IdUsuario> {
  const { deps, headers } = ctx;
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (!token) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_ausente' });
  }
  let sessao;
  try {
    sessao = await deps.authService.validarSessao(token);
  } catch {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
  }
  if (!sessao) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_expirada' });
  }
  return sessao.idUsuario as IdUsuario;
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof UsuarioNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof UsuarioInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

/**
 * Editable profile fields. `nomeExibicao` (= creatorName) lives on Usuario
 * and is updated via `atualizarPerfilUsuario`; everything else is profile
 * content. Dates arrive as ISO strings → coerced. Photo keys are accepted so
 * the contract is R5-ready (the upload flow calls back with the keys).
 */
const AtualizarPerfilInputSchema = z.object({
  nomeExibicao: z.string().trim().min(1).max(120),
  nomeBebe: z.string().trim().min(1).max(120).nullable(),
  relacao: z.string().trim().min(1).max(60).nullable(),
  historia: z.string().trim().max(600).nullable(),
  dataNascimento: z.coerce.date().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  dataEvento: z.coerce.date().nullable(),
  fotoPerfilKey: z.string().trim().min(1).max(512).nullable(),
  fotoCapaKey: z.string().trim().min(1).max(512).nullable(),
  fotoHistoriaKey: z.string().trim().min(1).max(512).nullable(),
});

export const perfilRouter = t.router({
  /**
   * Update the caller's profile content + display name in one round-trip.
   * Returns the fresh own-profile view so the client updates its cache
   * without a follow-up query.
   */
  atualizar: t.procedure
    .input(AtualizarPerfilInputSchema)
    .output(PerfilProprioDTOSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        const { nomeExibicao, ...conteudo } = input;

        await atualizarPerfilUsuario(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          { idUsuario, nomeExibicao },
        );

        await atualizarPerfilCriador(
          {
            perfilCriadorRepository: ctx.deps.perfilCriadorRepository,
            objectStorage: ctx.deps.objectStorage,
            observability: ctx.deps.observability,
            clock: ctx.deps.clock,
            gerarId: () => randomUUID() as IdPerfilCriador,
          },
          { idUsuario, ...conteudo },
        );

        return await obterPerfilCriador(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            perfilCriadorRepository: ctx.deps.perfilCriadorRepository,
            objectStorage: ctx.deps.objectStorage,
            observability: ctx.deps.observability,
          },
          idUsuario,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /** Read the caller's own full profile (painel form load). */
  getPerfil: t.procedure.output(PerfilProprioDTOSchema).query(async ({ ctx }) => {
    try {
      const idUsuario = await resolveCallerIdUsuario(ctx);
      return await obterPerfilCriador(
        {
          usuarioRepository: ctx.deps.usuarioRepository,
          perfilCriadorRepository: ctx.deps.perfilCriadorRepository,
          objectStorage: ctx.deps.objectStorage,
          observability: ctx.deps.observability,
        },
        idUsuario,
      );
    } catch (err) {
      throw toTRPCError(err);
    }
  }),

  /**
   * Emit a presigned PUT URL for a profile photo upload (aperture-kcasm).
   * AUTHED — `idUsuario` comes from the session cookie (never client input),
   * so the object key is namespaced to the caller. The client uploads the
   * bytes directly to the bucket, then persists `objectKey` via
   * `perfil.atualizar`. Bad content-type → BAD_REQUEST.
   */
  emitirUrlUploadFoto: t.procedure
    .input(EmitirUrlUploadFotoInputSchema)
    .output(
      z.object({
        uploadUrl: z.string(),
        objectKey: z.string(),
        publicUrl: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const idUsuario = await resolveCallerIdUsuario(ctx);
        return await emitirUrlUploadFoto(
          {
            objectStorage: ctx.deps.objectStorage,
            observability: ctx.deps.observability,
          },
          idUsuario,
          input,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * PUBLIC profile by slug — no auth. Returns the PII-safe projection only.
   * Unknown slug → NOT_FOUND. Powers the `/pagina/<slug>` public page (V2).
   */
  getPerfilPublicoBySlug: t.procedure
    .input(z.object({ slug: z.string().trim().min(1).max(60) }))
    .output(PerfilPublicoDTOSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await obterPerfilPublicoBySlug(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            perfilCriadorRepository: ctx.deps.perfilCriadorRepository,
            objectStorage: ctx.deps.objectStorage,
            observability: ctx.deps.observability,
          },
          ID_PLATAFORMA_EUNENEM,
          input.slug as SlugUsuario,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
