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
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  atualizarPerfilUsuario,
  campanhaPossuiAdministrador,
  type ConteudoPerfilCriador,
  EmitirUrlUploadFotoInputSchema,
  emitirUrlUploadFoto,
  type IdCampanha,
  type IdCampanhaEvento,
  type IdUsuario,
  PerfilProprioDTOSchema,
  PerfilPublicoDTOSchema,
  type SlugUsuario,
  UsuarioInputInvalidoError,
  UsuarioNaoEncontradoError,
} from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import type { TrpcContext } from './context.js';
import { type EventoDataPair, fotoUrlResolver } from './perfil-campanha-router.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';
import {
  resolverUsuarioAutenticado,
  resolverUsuarioAutenticadoOuNull,
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
 *
 * aperture-mu1v9: `tipoEvento`/`dataEvento` re-sourced from the campanha's
 * `eventos` row (single source) — perfil_campanhas' copy is legacy (PR2
 * drops the columns). DTO shape unchanged.
 */
function mapPerfilProprioFromCampanha(
  usuario: { slug: string; nomeExibicao: string },
  conteudo: ConteudoPerfilCriador | undefined,
  fotoUrl: (key: string | null) => string | null,
  evento: EventoDataPair | null | undefined,
): z.infer<typeof PerfilProprioDTOSchema> {
  const c = conteudo;
  return {
    slug: usuario.slug,
    creatorName: usuario.nomeExibicao,
    nomeBebe: c?.nomeBebe ?? null,
    relacao: c?.relacao ?? null,
    historia: c?.historia ?? null,
    tipoEvento: evento?.tipoEvento ?? null,
    genero: c?.genero ?? null,
    dataEvento: dateToIso(evento?.dataHora),
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
 *
 * aperture-mu1v9: `tipoEvento`/`dataEvento` re-sourced from the campanha's
 * `eventos` row (single source) — the public page date now always equals the
 * convite date. DTO shape unchanged.
 */
function mapPerfilPublicoFromCampanha(
  usuario: { slug: string; nomeExibicao: string },
  idCampanha: string | null,
  conteudo: ConteudoPerfilCriador | undefined,
  fotoUrl: (key: string | null) => string | null,
  evento: EventoDataPair | null | undefined,
  isOwner: boolean,
): z.infer<typeof PerfilPublicoDTOSchema> {
  const c = conteudo;
  return {
    slug: usuario.slug,
    idCampanha,
    creatorName: usuario.nomeExibicao,
    nomeBebe: c?.nomeBebe ?? null,
    relacao: c?.relacao ?? null,
    historia: c?.historia ?? null,
    tipoEvento: evento?.tipoEvento ?? null,
    genero: c?.genero ?? null,
    dataEvento: dateToIso(evento?.dataHora),
    dataNascimento: dateToIso(c?.dataNascimento),
    fotoPerfilUrl: fotoUrl(c?.fotoPerfilKey ?? null),
    fotoCapaUrl: fotoUrl(c?.fotoCapaKey ?? null),
    fotoHistoriaUrl: fotoUrl(c?.fotoHistoriaKey ?? null),
    papais: c?.papais ?? null,
    corPrimaria: c?.corPrimaria ?? null,
    corAcento: c?.corAcento ?? null,
    isOwner,
  };
}

/**
 * aperture-hsxim (fblrt W2): the baby-half is SHED — per-campanha profile
 * content is written EXCLUSIVELY via `perfilCampanha.atualizar({idCampanha})`.
 * This endpoint survives slim: `nomeExibicao` (= creatorName) lives on
 * Usuario (usuarios.nome_exibicao, written by `atualizarPerfilUsuario`) and
 * that is now ALL it updates. Baby fields sent by stale clients are stripped
 * by zod (unknown keys) — harmless during the deploy window; the migrated
 * frontend (aperture-qmaoi) targets perfilCampanha.atualizar.
 */
const AtualizarPerfilInputSchema = z.object({
  nomeExibicao: z.string().trim().min(1).max(120),
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
        // aperture-hsxim (W2 shed): SLIM endpoint — updates ONLY the
        // Usuario's nomeExibicao. The dual-write to perfil_criadores and the
        // baby-half upsert are GONE: per-campanha content is written
        // exclusively via perfilCampanha.atualizar({idCampanha}). Note the
        // baby-half write could not survive the slim input anyway — the
        // upsert has whole-content-replacement semantics, so calling it with
        // empty content would WIPE the campanha perfil on every name change.
        // Output shape unchanged: the DTO's baby-half is READ (not written)
        // from the oldest campanha's perfil_campanhas, same as getPerfil.
        const { usuario, campanha } = await resolverCampanhaAdministrada(ctx);
        const idUsuario = usuario.id as IdUsuario;
        const { nomeExibicao } = input;

        await atualizarPerfilUsuario(
          {
            usuarioRepository: ctx.deps.usuarioRepository,
            observability: ctx.deps.observability,
          },
          { idUsuario, nomeExibicao },
        );

        const perfil = await ctx.deps.perfilCampanhaRepository.findByIdCampanha(campanha.id);
        const evento = await ctx.deps.eventoRepository.findByIdCampanha(
          campanha.id as IdCampanhaEvento,
        );

        return mapPerfilProprioFromCampanha(
          { slug: usuario.slug, nomeExibicao },
          perfil?.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
          evento,
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
      const evento = await ctx.deps.eventoRepository.findByIdCampanha(
        campanha.id as IdCampanhaEvento,
      );
      return mapPerfilProprioFromCampanha(
        usuario,
        perfil?.conteudo,
        fotoUrlResolver(ctx.deps.objectStorage),
        evento,
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
        const evento = campanha
          ? await deps.eventoRepository.findByIdCampanha(campanha.id as IdCampanhaEvento)
          : undefined;

        // aperture — TweaksPanel "Salvar" ownership gate: a visitor's client
        // shows the Save button only when THEY are logged in AND are an
        // admin of the campanha being viewed. This probes the session
        // WITHOUT requiring one (resolverUsuarioAutenticadoOuNull → null for
        // anon/expired, same as auth.me) and reuses the domain's own
        // includes() check (campanhaPossuiAdministrador) rather than
        // reimplementing it. No new PII leaves this boundary — isOwner is a
        // boolean, never the caller's idConta/idUsuario/email.
        const sessao = await resolverUsuarioAutenticadoOuNull(ctx.deps, ctx.headers);
        const isOwner = Boolean(
          sessao && campanha && campanhaPossuiAdministrador(campanha, sessao.usuario.idConta),
        );

        return mapPerfilPublicoFromCampanha(
          usuario,
          campanha?.id ?? null,
          perfil?.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
          evento,
          isOwner,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
