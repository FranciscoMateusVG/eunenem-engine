/**
 * Campanhas tRPC router (aperture-mebax — multicampanha migration bridge POC,
 * epic aperture-7hm2g, design spec §6).
 *
 * Procedures:
 *   - `campanhas.list`  query, AUTHED → { novas, legado }
 *
 * The /campanhas page mixes the caller's 2.0 campaigns with any 1.0 legacy
 * campaigns detected via the static snapshot (lib/legacy-users.ts):
 *   - `novas`  = `findCampanhasByAdministrador(idConta)` (the port EXISTS in
 *     src/adapters/arrecadacao/campanha-repository.ts, previously wired only
 *     to the admin router — this is its first user-facing exposure) mapped to
 *     card DTOs, sorted `criadaEm` DESC.
 *   - `legado` = snapshot entries matching `usuario.email` case-insensitively,
 *     with the `nome` fallback applied server-side.
 *
 * CONTRACT: the return DTO shape is FROZEN on epic aperture-7hm2g notes — the
 * frontend (Vance) builds against it in parallel. `criadaEm` is serialized as
 * an ISO-8601 STRING here (this app registers no tRPC transformer, so a Date
 * would silently become a string on the wire while the inferred client type
 * claimed Date — serializing explicitly keeps type and wire in agreement).
 *
 * AUTH: the caller is resolved from the session cookie via the shared
 * `resolverUsuarioAutenticado` (A2 + OAuth-orphan self-heal). The client NEVER
 * sends idConta/email — no "list someone else's campaigns" shape. `slug` on
 * the 2.0 card DTO is the USUARIO's painel slug (Campanha has no slug of its
 * own); every card navigates to /painel/<slug> in the POC.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod/v4';
import type { Campanha } from '../../../../src/index.js';
import { buscarCampanhasLegado } from '../../lib/legacy-users.js';
import type { TrpcContext } from './context.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './session-resolver.js';

const t = initTRPC.context<TrpcContext>().create();

/** 2.0 campaign card DTO (contract frozen on epic aperture-7hm2g notes). */
const CampanhaNovaDTOSchema = z.object({
  id: z.string(),
  titulo: z.string(),
  /** The USER's painel slug — card navigates to `/painel/${slug}`. */
  slug: z.string(),
  /**
   * Mimo count for the card — `null` in the POC (a real received-mimos count
   * needs a per-campanha contribuições aggregate; deliberately out of scope,
   * the card hides the count on null). Field exists so wiring the count later
   * is contract-compatible.
   */
  quantidadeMimos: z.number().int().nonnegative().nullable(),
  /** ISO-8601. `novas` is sorted by this, DESC. */
  criadaEm: z.string(),
});

const CampanhaLegadoDTOSchema = z.object({
  email: z.string(),
  /** Never empty — server-side fallback applied in lib/legacy-users.ts. */
  nome: z.string(),
  utm: z.string().nullable(),
  mimos: z.number().int().nonnegative().nullable(),
});

const CampanhasListOutputSchema = z.object({
  novas: z.array(CampanhaNovaDTOSchema),
  legado: z.array(CampanhaLegadoDTOSchema),
});

export type CampanhasListOutput = z.infer<typeof CampanhasListOutputSchema>;

function toCardDTO(
  campanha: Campanha,
  slug: string,
): z.infer<typeof CampanhaNovaDTOSchema> {
  return {
    id: campanha.id,
    titulo: campanha.titulo,
    slug,
    quantidadeMimos: null,
    criadaEm: campanha.criadaEm.toISOString(),
  };
}

export const campanhasRouter = t.router({
  /**
   * All campaigns for the /campanhas mixed grid: the caller's 2.0 campanhas
   * (`novas`, criadaEm DESC) + matching 1.0 legacy snapshot entries
   * (`legado`). Both arrays always present; either may be empty.
   */
  list: t.procedure
    .output(CampanhasListOutputSchema)
    .query(async ({ ctx }): Promise<CampanhasListOutput> => {
      const { deps, headers } = ctx;

      let usuario: Awaited<ReturnType<typeof resolverUsuarioAutenticado>>['usuario'];
      try {
        ({ usuario } = await resolverUsuarioAutenticado(deps, headers));
      } catch (err) {
        if (err instanceof SessaoNaoAutenticadaError) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sessao_invalida' });
        }
        throw err;
      }

      try {
        const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(
          usuario.idConta,
        );
        const novas = [...campanhas]
          .sort((a, b) => b.criadaEm.getTime() - a.criadaEm.getTime())
          .map((campanha) => toCardDTO(campanha, usuario.slug));

        // Static-snapshot legacy detection (spec §4) — pure, in-memory match;
        // no legacy-system call at runtime.
        const legado = buscarCampanhasLegado(usuario.email);

        return { novas, legado: [...legado] };
      } catch (err) {
        throw err instanceof Error
          ? new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message, cause: err })
          : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'unknown_error' });
      }
    }),
});
