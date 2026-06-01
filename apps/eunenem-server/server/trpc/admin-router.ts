/**
 * Admin tRPC router (aperture-rsidz.2, W1; aperture-tinly, W-tsrd4b prep).
 *
 * The data layer for the operator's DDD-trace drill-down. v1 is read-only:
 * `searchUsers` for the picker, `findUsuarioByConta` for the detail page,
 * and `usuarios.listPaginated` for the browse-as-default landing table.
 *
 * v1 has NO auth gate (operator directive). Anyone with the URL gets in.
 * When auth lands in v2, this is one of the boundaries that gates against
 * the operator role.
 *
 * Tenant scope is hardcoded to `ID_PLATAFORMA_EUNENEM`. Multi-tenancy is
 * deferred; for v1 every admin query is implicitly scoped to eunenem.
 *
 * Procedures intentionally project the engine `Usuario` aggregate down to
 * a flat result shape with just the fields the UI needs. We don't leak
 * the full aggregate (permissions, conta, slug, ...) over the wire —
 * that's both a footprint and a discipline win: the wire contract is
 * decoupled from the domain model.
 */
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { ID_PLATAFORMA_EUNENEM } from "../../../../src/index.js";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

/** Wire shape — kept narrow so we never leak the full Usuario aggregate. */
const UsuarioMatchSchema = z.object({
  idConta: z.string(),
  email: z.string(),
  nomeExibicao: z.string(),
});
export type UsuarioMatch = z.infer<typeof UsuarioMatchSchema>;

/* ─────────────────────────────────────────────────────────────────────────
 * usuarios.listPaginated — browse-as-default users table (aperture-tinly).
 *
 * Wires through to the engine port `findUsuariosPaginated(idPlataforma, input)`
 * from aperture-qatwz (Rex, PR #98). The DTO projection is the only
 * eunenem-specific shape — the wire output trims the full Usuario aggregate
 * down to the six fields the UI consumes (id, idConta, email, nomeExibicao,
 * slug, criadoEm) so we never leak the aggregate over the wire.
 *
 * The cursor format + sort tuple + filter semantics are owned by the
 * engine adapter — this proc just passes input through and projects the
 * output. base64url opaque cursors, tuple-comparison tie-break on
 * idUsuario, LIKE-escape on emailPrefix, exact tenant-scoped totalCount.
 * Documentation lives on the port itself.
 * ────────────────────────────────────────────────────────────────────── */

const UsuarioAdminDTOSchema = z.object({
  id: z.string(),
  idConta: z.string(),
  email: z.string(),
  nomeExibicao: z.string(),
  slug: z.string(),
  criadoEm: z.string(),
});
export type UsuarioAdminDTO = z.infer<typeof UsuarioAdminDTOSchema>;

const SortBySchema = z.enum(["criadoEm", "email", "nomeExibicao"]);
const SortDirSchema = z.enum(["asc", "desc"]);

const ListPaginatedInputSchema = z.object({
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100),
  sortBy: SortBySchema,
  sortDir: SortDirSchema,
  emailPrefix: z.string().max(120).optional(),
});

const ListPaginatedOutputSchema = z.object({
  usuarios: z.array(UsuarioAdminDTOSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().min(0),
});

const usuariosRouter = t.router({
  /**
   * Cursor-paginated tenant-scoped browse of usuarios. Tri-state sort
   * (criadoEm / email / nomeExibicao × asc/desc), LIKE-escaped
   * emailPrefix filter, exact totalCount.
   *
   * Backed by `UsuarioRepository.findUsuariosPaginated` (Wheatley §6
   * contract, Rex aperture-qatwz / PR #98). The proc projects the full
   * Usuario aggregate down to the lean DTO the UI consumes; cursor +
   * sort + filter semantics live on the port.
   */
  listPaginated: t.procedure
    .input(ListPaginatedInputSchema)
    .output(ListPaginatedOutputSchema)
    .query(async ({ ctx, input }) => {
      const result = await ctx.deps.usuarioRepository.findUsuariosPaginated(
        ID_PLATAFORMA_EUNENEM,
        {
          cursor: input.cursor,
          limit: input.limit,
          sortBy: input.sortBy,
          sortDir: input.sortDir,
          emailPrefix: input.emailPrefix,
        },
      );

      return {
        usuarios: result.usuarios.map((u) => ({
          id: u.id,
          idConta: u.idConta,
          email: u.email,
          nomeExibicao: u.nomeExibicao,
          slug: u.slug,
          criadoEm: u.criadoEm.toISOString(),
        })),
        nextCursor: result.nextCursor,
        totalCount: result.totalCount,
      };
    }),
});

const SEARCH_LIMIT = 20;

export const adminRouter = t.router({
  /** Nested sub-router for usuarios browse + paginated list. */
  usuarios: usuariosRouter,

  /**
   * Prefix-search usuarios by email. Case-insensitive (the postgres
   * adapter does `LOWER(email) ILIKE LOWER($2) || '%'`). Tenant-scoped to
   * ID_PLATAFORMA_EUNENEM. Empty/blank prefix → empty array (don't return
   * the full table). Bounded by `SEARCH_LIMIT`.
   *
   * Backed by `UsuarioRepository.findUsuariosByEmailPrefix` (engine
   * aperture-5d3yz / PR #93).
   */
  searchUsers: t.procedure
    .input(
      z.object({
        prefix: z.string().max(120),
      }),
    )
    .output(z.array(UsuarioMatchSchema))
    .query(async ({ ctx, input }) => {
      const cleaned = input.prefix.trim();
      if (cleaned === "") return [];

      const usuarios = await ctx.deps.usuarioRepository.findUsuariosByEmailPrefix(
        ID_PLATAFORMA_EUNENEM,
        cleaned,
        SEARCH_LIMIT,
      );

      return usuarios.map((u) => ({
        idConta: u.idConta,
        email: u.email,
        nomeExibicao: u.nomeExibicao,
      }));
    }),

  /**
   * Single usuario lookup by `idConta` (the public conta id from URL).
   * Used by the /admin/usuario/:idConta detail page after the picker
   * hands off the id. Returns null when nothing matches — the page
   * renders a 404.
   *
   * The engine has no direct `findUsuarioByContaId` port yet, so we
   * cascade through two existing ports:
   *   1. `findContaById(idConta)`  → Conta (which carries idUsuario)
   *   2. `findUsuarioById(idUsuario)` → Usuario
   *
   * Both are bounded postgres lookups, so the latency cost is two
   * round-trips — acceptable for v1's read-only admin surface. If the
   * page gets hot enough to matter, file a follow-up bead for a single
   * direct port and collapse this to a one-liner.
   */
  findUsuarioByConta: t.procedure
    .input(
      z.object({
        idConta: z.string(),
      }),
    )
    .output(UsuarioMatchSchema.nullable())
    .query(async ({ ctx, input }) => {
      const conta = await ctx.deps.usuarioRepository.findContaById(
        input.idConta as never,
      );
      if (!conta) return null;

      const usuario = await ctx.deps.usuarioRepository.findUsuarioById(
        conta.idUsuario,
      );
      if (!usuario) return null;

      // Tenant guard — never cross the multi-tenant boundary.
      if (usuario.idPlataforma !== ID_PLATAFORMA_EUNENEM) return null;

      return {
        idConta: usuario.idConta,
        email: usuario.email,
        nomeExibicao: usuario.nomeExibicao,
      };
    }),
});
