/**
 * PerfilCampanha tRPC router (aperture-aphk8, W1a) — per-campanha profile.
 *
 * Procedures:
 *   - `perfilCampanha.get`                  query,    AUTHED → PerfilCampanhaDTO
 *   - `perfilCampanha.atualizar`            mutation, AUTHED → PerfilCampanhaDTO
 *   - `perfilCampanha.emitirUrlUploadFoto`  mutation, AUTHED → presigned PUT URL
 *
 * Every hop owner-gates via `resolverCampanhaAdministrada(ctx, idCampanha)`
 * (REQUIRED-present branch): not-found and not-owner collapse to the same
 * non-leaking sentinel → UNAUTHORIZED. The DTO mirrors PerfilProprioDTO's
 * content half (baby fields + resolved photo URLs for display + bare keys
 * for round-trip); dates are ISO strings (no tRPC transformer registered).
 *
 * Content reuses the ConteudoPerfilCriador VO verbatim (W1 design §1.2) —
 * whole-content replacement upsert, same semantics as perfil.atualizar's
 * baby-half.
 */
import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import {
  ArrecadacaoInputInvalidoError,
  atualizarConteudoPerfilCampanha,
  type ConteudoPerfilCriador,
  ConteudoPerfilCriadorSchema,
  criarPerfilCampanha,
  EmitirUrlUploadFotoCampanhaInputSchema,
  emitirUrlUploadFotoCampanha,
  GeneroBebeSchema,
  type IdCampanha,
  type IdPerfilCampanha,
  type ObjectStorage,
  type PerfilCampanha,
  type PerfilCampanhaRepository,
  TipoEventoPerfilSchema,
} from '../../../../src/index.js';
import type { TrpcContext } from './context.js';
import {
  CampanhaAcessoNegadoError,
  CampanhaInexistenteError,
  resolverCampanhaAdministrada,
} from './resolve-campanha-administrada.js';

const t = initTRPC.context<TrpcContext>().create();

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  // Non-leaking: session failure, not-owner, and not-found all collapse here.
  if (err instanceof CampanhaAcessoNegadoError) {
    return new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
  }
  // Absent-branch inconsistency (caller administers no campanha) — fail loud.
  if (err instanceof CampanhaInexistenteError) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoInputInvalidoError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
    : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
}

/**
 * Per-campanha profile DTO. Content half of PerfilProprioDTO (no
 * slug/creatorName — those stay on the Usuario) keyed by idCampanha. Url
 * fields are DISPLAY ONLY resolved URLs; Key fields are the bare
 * object-storage keys the client round-trips on save (aperture-qjgfr split).
 */
export const PerfilCampanhaDTOSchema = z.object({
  idCampanha: z.string(),
  nomeBebe: z.string().nullable(),
  relacao: z.string().nullable(),
  historia: z.string().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  genero: GeneroBebeSchema.nullable(),
  /** ISO-8601 or null (no transformer on the wire). */
  dataEvento: z.string().nullable(),
  /** ISO-8601 or null (no transformer on the wire). */
  dataNascimento: z.string().nullable(),
  fotoPerfilUrl: z.string().nullable(),
  fotoCapaUrl: z.string().nullable(),
  fotoHistoriaUrl: z.string().nullable(),
  fotoPerfilKey: z.string().nullable(),
  fotoCapaKey: z.string().nullable(),
  fotoHistoriaKey: z.string().nullable(),
});

export type PerfilCampanhaDTO = z.infer<typeof PerfilCampanhaDTOSchema>;

function dateToIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Map a campanha id + (possibly absent) profile content to the DTO. A
 * campanha with no perfil_campanhas row yet renders as all-null content —
 * the form shows empty, not an error.
 */
export function toPerfilCampanhaDTO(
  idCampanha: string,
  conteudo: ConteudoPerfilCriador | undefined,
  fotoUrl: (key: string | null) => string | null,
): PerfilCampanhaDTO {
  const c = conteudo;
  return {
    idCampanha,
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

/** Resolver for stored photo keys → displayable URLs (aperture-lq8vw pattern). */
export function fotoUrlResolver(
  objectStorage: ObjectStorage,
): (key: string | null) => string | null {
  return (key) => (key === null ? null : objectStorage.urlPublica(key));
}

/**
 * The editable per-campanha content — the EXACT baby-half of perfil-router's
 * AtualizarPerfilInputSchema (minus nomeExibicao, which lives on Usuario).
 * Dates arrive as ISO strings → coerced.
 */
const ConteudoPerfilCampanhaInputSchema = z.object({
  nomeBebe: z.string().trim().min(1).max(120).nullable(),
  relacao: z.string().trim().min(1).max(60).nullable(),
  historia: z.string().trim().max(600).nullable(),
  dataNascimento: z.coerce.date().nullable(),
  tipoEvento: TipoEventoPerfilSchema.nullable(),
  genero: GeneroBebeSchema.nullable().default(null),
  dataEvento: z.coerce.date().nullable(),
  fotoPerfilKey: z.string().trim().min(1).max(512).nullable(),
  fotoCapaKey: z.string().trim().min(1).max(512).nullable(),
  fotoHistoriaKey: z.string().trim().min(1).max(512).nullable(),
});

const AtualizarPerfilCampanhaInputSchema = ConteudoPerfilCampanhaInputSchema.extend({
  idCampanha: z.string().uuid(),
});

export interface UpsertConteudoPerfilCampanhaDeps {
  readonly perfilCampanhaRepository: PerfilCampanhaRepository;
  readonly objectStorage: ObjectStorage;
  readonly clock: () => Date;
}

/**
 * Whole-content replacement upsert of a campanha's profile (aperture-aphk8).
 * Mirrors `atualizarPerfilCriador`'s semantics 1:1:
 *   - incoming fotoXKey values are normalized back to bare keys via
 *     `extrairKey` (idempotent, self-healing — aperture-qjgfr);
 *   - content re-validated as the ConteudoPerfilCriador VO (single source of
 *     truth for field invariants);
 *   - existing row → replace content + bump atualizadoEm (id + criadoEm
 *     preserved by the adapter's 1:1 upsert); none → create fresh.
 *
 * Exported for the perfil-router transitional shim (dual-write of the
 * oldest campanha's baby-half). Auth is NOT enforced here — callers
 * owner-gate `idCampanha` first.
 */
export async function upsertConteudoPerfilCampanha(
  deps: UpsertConteudoPerfilCampanhaDeps,
  idCampanha: IdCampanha,
  conteudoInput: z.infer<typeof ConteudoPerfilCampanhaInputSchema>,
): Promise<PerfilCampanha> {
  const { perfilCampanhaRepository, objectStorage, clock } = deps;
  const normalizarKey = (key: string | null): string | null =>
    key === null ? null : objectStorage.extrairKey(key);

  const conteudoParsed = ConteudoPerfilCriadorSchema.safeParse({
    ...conteudoInput,
    fotoPerfilKey: normalizarKey(conteudoInput.fotoPerfilKey),
    fotoCapaKey: normalizarKey(conteudoInput.fotoCapaKey),
    fotoHistoriaKey: normalizarKey(conteudoInput.fotoHistoriaKey),
  });
  if (!conteudoParsed.success) {
    const message = conteudoParsed.error.issues.map((i) => i.message).join('; ');
    throw new ArrecadacaoInputInvalidoError(message);
  }
  const conteudo: ConteudoPerfilCriador = conteudoParsed.data;

  const now = clock();
  const existing = await perfilCampanhaRepository.findByIdCampanha(idCampanha);
  const perfil = existing
    ? atualizarConteudoPerfilCampanha(existing, { conteudo, atualizadoEm: now })
    : criarPerfilCampanha({
        id: randomUUID() as IdPerfilCampanha,
        idCampanha,
        conteudo,
        criadoEm: now,
      });

  await perfilCampanhaRepository.save(perfil);
  return perfil;
}

export const perfilCampanhaRouter = t.router({
  /**
   * Read one campanha's profile. Owner-gated (present branch). A campanha
   * with no profile row returns the all-null DTO (form renders empty).
   */
  get: t.procedure
    .input(z.object({ idCampanha: z.string().uuid() }))
    .output(PerfilCampanhaDTOSchema)
    .query(async ({ ctx, input }) => {
      try {
        const { campanha } = await resolverCampanhaAdministrada(ctx, input.idCampanha);
        const perfil = await ctx.deps.perfilCampanhaRepository.findByIdCampanha(campanha.id);
        return toPerfilCampanhaDTO(
          campanha.id,
          perfil?.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Whole-content replacement upsert of one campanha's profile. Owner-gated.
   * Returns the fresh DTO so the client updates its cache without a
   * follow-up query.
   */
  atualizar: t.procedure
    .input(AtualizarPerfilCampanhaInputSchema)
    .output(PerfilCampanhaDTOSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const { idCampanha, ...conteudoInput } = input;
        const { campanha } = await resolverCampanhaAdministrada(ctx, idCampanha);

        const perfil = await upsertConteudoPerfilCampanha(
          {
            perfilCampanhaRepository: ctx.deps.perfilCampanhaRepository,
            objectStorage: ctx.deps.objectStorage,
            clock: ctx.deps.clock,
          },
          campanha.id,
          conteudoInput,
        );

        return toPerfilCampanhaDTO(
          campanha.id,
          perfil.conteudo,
          fotoUrlResolver(ctx.deps.objectStorage),
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /**
   * Emit a presigned PUT URL for a per-campanha profile photo upload.
   * Owner-gated — the object key is namespaced `campanha/<idCampanha>/...`
   * (never raw client input). The client uploads the bytes directly to the
   * bucket, then persists `objectKey` via `perfilCampanha.atualizar`.
   */
  emitirUrlUploadFoto: t.procedure
    .input(
      EmitirUrlUploadFotoCampanhaInputSchema.extend({
        idCampanha: z.string().uuid(),
      }),
    )
    .output(
      z.object({
        uploadUrl: z.string(),
        objectKey: z.string(),
        publicUrl: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { idCampanha, ...uploadInput } = input;
        const { campanha } = await resolverCampanhaAdministrada(ctx, idCampanha);
        return await emitirUrlUploadFotoCampanha(
          {
            objectStorage: ctx.deps.objectStorage,
            observability: ctx.deps.observability,
          },
          campanha.id,
          uploadInput,
        );
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});
