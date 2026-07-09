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
  type ConteudoPerfilCriador,
  EmitirUrlUploadFotoInputSchema,
  emitirUrlUploadFoto,
  type IdCampanha,
  type IdPerfilCriador,
  type IdUsuario,
  PerfilProprioDTOSchema,
  PerfilPublicoDTOSchema,
  GeneroBebeSchema,
  type SlugUsuario,
  TipoEventoPerfilSchema,
  UsuarioInputInvalidoError,
  UsuarioNaoEncontradoError,
} from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';
import { fotoUrlResolver, upsertConteudoPerfilCampanha } from './perfil-campanha-router.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

async function resolveCallerIdUsuario(ctx: TrpcContext): Promise<IdUsuario> {
  const { deps, headers } = ctx;
  // aperture-6wo1f: central A2 + OAuth-orphan self-heal. Returns the resolved
  // (healed-if-orphan) usuario; only its id is exposed here. Map the shared
  // sentinel to the existing UNAUTHORIZED shape.
  try {
    const { usuario } = await resolverUsuarioAutenticado(deps, headers);
    return usuario.id as IdUsuario;
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
    }
    throw err;
  }
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof UsuarioNaoEncontradoError) {
    return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
  }
  if (err instanceof UsuarioInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  // aperture-aphk8 shim: the authed hops now resolve the caller's OLDEST
  // campanha via resolverCampanhaAdministrada. Its session-failure sentinel
  // maps to the SAME UNAUTHORIZED shape the old resolveCallerIdUsuario threw;
  // an authed caller with NO campanha at all is a data-model inconsistency
  // (signup saga always creates one) → fail loud.
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida', cause: err });
  }
  if (err instanceof CampanhaInexistenteError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

function dateToIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Build the own-profile DTO from Usuario identity + a campanha profile's
 * content (aperture-aphk8 shim). Same shape `obterPerfilCriador` produced —
 * OUTPUT CONTRACT UNCHANGED — but the baby-half now comes from the OLDEST
 * campanha's perfil_campanhas row instead of perfil_criadores.
 */
function mapPerfilProprioFromCampanha(
  usuario: { slug: string; nomeExibicao: string },
  conteudo: ConteudoPerfilCriador | undefined,
  fotoUrl: (key: string | null) => string | null,
): z.infer<typeof PerfilProprioDTOSchema> {
  const c = conteudo;
  return {
    slug: usuario.slug,
    creatorName: usuario.nomeExibicao,
    nomeBebe: c?.nomeBebe ?? null,
    relacao: c?.relacao ?? null,
    historia: c?.historia ?? null,
    tipoEvento: c?.tipoEvento ?? null,
    genero: c?.genero ?? null,
    dataEvento: dateToIso(c?.dataEvento),
    dataNascimento: dateToIso(c?.dataNascimento),
    fotoPerfilUrl: fotoUrl(c?.fotoPerfilKey ?? null),
    fotoCapaUrl: fotoUrl(c?.fotoCapaKey ?? null),
    fotoHistoriaUrl: fotoUrl(c?.fotoHistoriaKey ?? null),
    fotoPerfilKey: c?.fotoPerfilKey ?? null,
    fotoCapaKey: c?.fotoCapaKey ?? null,
    fotoHistoriaKey: c?.fotoHistoriaKey ?? null,
  };
}

/**
 * Build the PII-safe public DTO from Usuario identity + a campanha profile's
 * content (aperture-aphk8). OUTPUT SHAPE UNCHANGED from the perfil_criadores
 * era — `nomeExibicao` (creatorName) still comes from the Usuario.
 */
function mapPerfilPublicoFromCampanha(
  usuario: { slug: string; nomeExibicao: string },
  conteudo: ConteudoPerfilCriador | undefined,
  fotoUrl: (key: string | null) => string | null,
): z.infer<typeof PerfilPublicoDTOSchema> {
  const c = conteudo;
  return {
    slug: usuario.slug,
    creatorName: usuario.nomeExibicao,
    nomeBebe: c?.nomeBebe ?? null,
    relacao: c?.relacao ?? null,
    historia: c?.historia ?? null,
    tipoEvento: c?.tipoEvento ?? null,
    genero: c?.genero ?? null,
    dataEvento: dateToIso(c?.dataEvento),
    dataNascimento: dateToIso(c?.dataNascimento),
    fotoPerfilUrl: fotoUrl(c?.fotoPerfilKey ?? null),
    fotoCapaUrl: fotoUrl(c?.fotoCapaKey ?? null),
    fotoHistoriaUrl: fotoUrl(c?.fotoHistoriaKey ?? null),
  };
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
  // Optional-with-default so existing callers (PerfilBody form, OnboardingWizard)
  // compile before the frontend wires the gender selector; once they send it,
  // it flows through. New field → no existing data to clobber in the interim.
  genero: GeneroBebeSchema.nullable().default(null),
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
        // aperture-aphk8 TRANSITIONAL SHIM — input/output shapes UNCHANGED.
        // The baby-half now writes the caller's OLDEST campanha's
        // perfil_campanhas row (absent-branch resolve = back-compat rule);
        // nomeExibicao keeps its Usuario path.
        const { usuario, campanha } = await resolverCampanhaAdministrada(ctx);
        const idUsuario = usuario.id as IdUsuario;
        const { nomeExibicao, ...conteudo } = input;

        await atualizarPerfilUsuario(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          { idUsuario, nomeExibicao },
        );

        // DUAL-WRITE (aperture-aphk8): keep writing perfil_criadores too so
        // nothing is lost if W1 rolls back — the READ side below already
        // comes from perfil_campanhas. Remove this once W1 is locked in.
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

        const perfil = await upsertConteudoPerfilCampanha(
          {
            perfilCampanhaRepository: ctx.deps.perfilCampanhaRepository,
            objectStorage: ctx.deps.objectStorage,
            clock: ctx.deps.clock,
          },
          campanha.id,
          conteudo,
        );

        return mapPerfilProprioFromCampanha(
          { slug: usuario.slug, nomeExibicao },
          perfil.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /** Read the caller's own full profile (painel form load). */
  getPerfil: t.procedure.output(PerfilProprioDTOSchema).query(async ({ ctx }) => {
    try {
      // aperture-aphk8 shim: baby-half reads the OLDEST campanha's
      // perfil_campanhas row; identity half stays on Usuario. Output shape
      // unchanged.
      const { usuario, campanha } = await resolverCampanhaAdministrada(ctx);
      const perfil = await ctx.deps.perfilCampanhaRepository.findByIdCampanha(campanha.id);
      return mapPerfilProprioFromCampanha(
        usuario,
        perfil?.conteudo,
        fotoUrlResolver(ctx.deps.objectStorage),
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
    .input(
      z.object({
        slug: z.string().trim().min(1).max(60),
        // aperture-aphk8: OPTIONAL per-campanha routing. Absent → the conta's
        // OLDEST campanha (back-compat); present → that campanha, verified to
        // belong to the slug's conta (non-leaking NOT_FOUND otherwise).
        idCampanha: z.string().uuid().optional(),
      }),
    )
    .output(PerfilPublicoDTOSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { deps } = ctx;
        const usuario = await deps.usuarioRepository.findUsuarioBySlug(
          ID_PLATAFORMA_EUNENEM,
          input.slug as SlugUsuario,
        );
        if (!usuario) {
          throw new UsuarioNaoEncontradoError(input.slug);
        }

        let campanha: Awaited<ReturnType<typeof deps.campanhaRepository.findById>>;
        if (input.idCampanha !== undefined && input.idCampanha !== '') {
          campanha = await deps.campanhaRepository.findById(input.idCampanha as IdCampanha);
          // Not-found AND not-owned-by-the-slug's-conta collapse to the SAME
          // NOT_FOUND — a visitor can't distinguish which.
          if (!campanha || !campanha.idsAdministradores.includes(usuario.idConta)) {
            throw new UsuarioNaoEncontradoError(input.slug);
          }
        } else {
          // Back-compat: bare slug → the conta's OLDEST campanha. A conta
          // with no campanha (shouldn't happen post-signup-saga) degrades to
          // the all-null-content projection rather than a 404 — same
          // behavior the perfil_criadores-era read had for a profile-less
          // user.
          campanha = await deps.campanhaRepository.findByAdministrador(usuario.idConta);
        }

        const perfil = campanha
          ? await deps.perfilCampanhaRepository.findByIdCampanha(campanha.id)
          : undefined;

        return mapPerfilPublicoFromCampanha(
          usuario,
          perfil?.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
