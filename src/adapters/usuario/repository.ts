import type { Conta, Usuario } from '../../domain/usuario/entities/usuario.js';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import type { SlugUsuario } from '../../domain/usuario/value-objects/slug-usuario.js';

/**
 * Sort columns supported by `findUsuariosPaginated` (aperture-qatwz).
 * Map to db columns `criado_em`, `email`, `nome_exibicao` respectively.
 */
export type UsuarioPaginadoSortBy = 'criadoEm' | 'email' | 'nomeExibicao';

export type UsuarioPaginadoSortDir = 'asc' | 'desc';

export interface FindUsuariosPaginadosInput {
  /** Opaque cursor from a previous call's `nextCursor`. `null` = first page. */
  readonly cursor: string | null;
  /** Page size. Clamped server-side to [1, 100]; non-integer values are floored. */
  readonly limit: number;
  /** Which column to sort by. Tie-break on `idUsuario` is automatic. */
  readonly sortBy: UsuarioPaginadoSortBy;
  /** Sort direction. */
  readonly sortDir: UsuarioPaginadoSortDir;
  /**
   * Optional case-insensitive email prefix filter. Empty/undefined returns
   * the full tenant (different from `findUsuariosByEmailPrefix` semantics —
   * intentional divergence). LIKE metacharacters are escaped to literal.
   */
  readonly emailPrefix?: string;
}

export interface FindUsuariosPaginadosOutput {
  readonly usuarios: readonly Usuario[];
  /** `null` when there are no more pages. Otherwise an opaque cursor for the next page. */
  readonly nextCursor: string | null;
  /** Exact tenant-scoped count, respects the `emailPrefix` filter. */
  readonly totalCount: number;
}

/**
 * Persistência da raiz Usuario + Conta (porta).
 *
 * **Auth credentials are NOT persisted here** (aperture-ibbet) — they live
 * on the `AuthService` port + adapter. This repository owns ONLY the
 * domain Usuario aggregate (Usuario + Conta).
 *
 * Uniqueness de email é composta `(idPlataforma, email)` — a mesma pessoa
 * pode registrar-se em eunenem E eucasei como dois `Usuario` distintos.
 */
export interface UsuarioRepository {
  /**
   * Persists the domain Usuario aggregate (Usuario root + Conta inner
   * entity) atomically. Throws `UsuarioEmailJaExisteError` if
   * `(idPlataforma, email)` is already taken.
   *
   * Renamed from the old `saveRegistro(bundle)` which also carried a
   * `credencial` field — credentials now live on the `AuthService`
   * adapter and are written by `registrarContaUsuario` BEFORE this call.
   */
  saveRegistroDomain(bundle: { readonly usuario: Usuario; readonly conta: Conta }): Promise<void>;

  findUsuarioById(id: IdUsuario): Promise<Usuario | undefined>;
  findUsuarioByEmail(
    idPlataforma: IdPlataformaReferencia,
    email: EmailUsuario,
  ): Promise<Usuario | undefined>;
  /**
   * Case-insensitive prefix search on email, scoped to a single
   * plataforma, bounded by `limit` (aperture-5d3yz). Used by the
   * eunenem-v2 admin user picker for autocomplete: operator types "mari"
   * and gets back the first N matching usuarios for the tenant.
   *
   * Contract:
   *   - Case-insensitive: "mari" matches "Mariana" and "MARIA".
   *   - Pure prefix — does NOT match substring (no leading wildcard).
   *   - Empty `prefix` → empty result (does NOT return all users).
   *   - LIKE-metacharacters in `prefix` (`%`, `_`, `\`) are escaped and
   *     treated as literals — caller-supplied input is not a pattern.
   *   - Results ordered by email ascending for deterministic UX.
   *   - Tenant-scoped: only returns usuarios whose `idPlataforma` matches.
   *   - At most `limit` rows. Caller picks the limit (e.g. 20).
   */
  findUsuariosByEmailPrefix(
    idPlataforma: IdPlataformaReferencia,
    prefix: string,
    limit: number,
  ): Promise<readonly Usuario[]>;
  /**
   * Cursor-paginated browse of usuarios for a single plataforma
   * (aperture-qatwz). Powers the `/admin` landing page browse-as-default
   * users table.
   *
   * Contract:
   *   - Tenant-scoped: only returns usuarios for the given `idPlataforma`.
   *   - `limit` clamped server-side to `[1, 100]` (default suggested: 50).
   *     Non-integer values are floored.
   *   - `sortBy` ∈ {`criadoEm`, `email`, `nomeExibicao`}. Sort stability is
   *     guaranteed via tie-break on `idUsuario` — every sort tuple is
   *     `(sortColumn, idUsuario)`, encoded into the cursor.
   *   - `sortDir` ∈ {`asc`, `desc`}. Caller picks; defaults are a
   *     presentation concern.
   *   - `emailPrefix` is an OPTIONAL filter applied BEFORE pagination.
   *     Case-insensitive prefix match (same shape as
   *     `findUsuariosByEmailPrefix`), with LIKE metacharacters (`%`, `_`,
   *     `\`) escaped to literal. Empty or undefined `emailPrefix` means
   *     "no filter" and returns the full tenant — DIFFERENT semantics
   *     from `findUsuariosByEmailPrefix` (which returns empty on empty
   *     input). The divergence is intentional: this is the BROWSE
   *     surface, not an AUTOCOMPLETE surface.
   *   - `cursor` is OPAQUE to the client. Server is free to change the
   *     internal shape. Round-tripped between server and client only.
   *     `null` cursor → first page. Last page → `nextCursor: null`.
   *   - `totalCount` is EXACT tenant-scoped count that respects the
   *     filter (changing `emailPrefix` changes `totalCount`). Cheap at
   *     scale because Postgres uses the `(id_plataforma, ...)` composite
   *     indexes for an index-only scan. If a tenant grows past ~100k
   *     usuarios, switch to approximate via `pg_class.reltuples` — file a
   *     follow-up bead when observation shows the threshold matters.
   *   - Throws `Error('Invalid pagination cursor: ...')` if the cursor
   *     fails to decode. A malformed cursor is either client corruption
   *     or a server-side bug — fail loudly, do NOT silently fall back to
   *     first page (which would mask state bugs).
   *
   * Do NOT extend this method to absorb `findUsuariosByEmailPrefix` — the
   * two ports have intentionally diverging semantics (browse vs.
   * autocomplete) and serve different UX surfaces (UsersTable vs.
   * UserPicker dropdown).
   */
  findUsuariosPaginated(
    idPlataforma: IdPlataformaReferencia,
    input: FindUsuariosPaginadosInput,
  ): Promise<FindUsuariosPaginadosOutput>;
  /**
   * Lookup by composite `(idPlataforma, slug)` (aperture-khbow). Used by the
   * eunenem-server SSR route `/painel/[slug]` to resolve the owner of a
   * public dashboard URL. Returns `undefined` for unknown slugs (caller
   * decides whether to 404 or show a public placeholder).
   */
  findUsuarioBySlug(
    idPlataforma: IdPlataformaReferencia,
    slug: SlugUsuario,
  ): Promise<Usuario | undefined>;
  findContaById(id: IdContaUsuario): Promise<Conta | undefined>;
  /**
   * Resolve a Usuario from its Conta id, tenant-scoped (aperture-lp9cw).
   * Returns the Usuario when `idConta` belongs to a Conta whose Usuario
   * is on `idPlataforma`; returns `undefined` for unknown idConta OR for
   * idConta whose Usuario is on a different plataforma.
   *
   * This collapses the legacy 2-hop fetch pattern (findContaById →
   * findUsuarioById → tenant-guard) into a single port call. Used by the
   * admin /admin/usuario/:idConta page on every load — one round-trip
   * instead of two.
   *
   * Tenant isolation is part of the contract: a wrong-tenant idConta
   * MUST NOT return a Usuario from another plataforma. Postgres adapter
   * enforces via JOIN + WHERE filter; memory adapter checks the
   * resolved Usuario's idPlataforma before returning.
   */
  findUsuarioByConta(
    idConta: IdContaUsuario,
    idPlataforma: IdPlataformaReferencia,
  ): Promise<Usuario | undefined>;
  atualizarNomeExibicaoUsuario(
    idUsuario: IdUsuario,
    nomeExibicao: NomeExibicaoUsuario,
  ): Promise<void>;

  /**
   * Removes the domain Usuario aggregate (Usuario root + Conta inner entity).
   * Used by the `registrarContaUsuario` saga as a T3 compensation when a
   * downstream step (e.g. campanha creation) fails after `saveRegistroDomain`
   * has already written the rows. Idempotent — deleting an unknown id is a
   * no-op (DELETE affects zero rows). The FK `contas.id_usuario ON DELETE
   * CASCADE` cleans up the Conta row in one statement.
   *
   * Does NOT touch the BetterAuth-side `users` table — that's owned by
   * `AuthService.removerConta`. The saga calls both in LIFO compensation
   * order.
   */
  removeRegistroDomain(idUsuario: IdUsuario): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
//  Shared cursor helpers for `findUsuariosPaginated` (aperture-qatwz).
//
//  Both adapters import these so the cursor wire-shape is canonical and
//  cursors emitted by either adapter would decode the same way (relevant
//  for conformance tests that round-trip cursors through both adapters).
// ─────────────────────────────────────────────────────────────────────────

export interface UsuarioPaginadoCursor {
  /** String representation of the sort column value at the boundary row. */
  readonly sortValue: string;
  /** Tie-break key — the `Usuario.id` of the boundary row. */
  readonly idUsuario: string;
}

/**
 * Server-side limit clamp: every adapter MUST apply this before reading.
 * `[1, 100]` per Wheatley's contract; non-integer floored to keep the
 * page-size semantics consistent.
 */
export function clampUsuariosPaginadosLimit(limit: number): number {
  const floored = Math.floor(limit);
  if (Number.isNaN(floored)) return 1;
  if (floored < 1) return 1;
  if (floored > 100) return 100;
  return floored;
}

/**
 * Encode a cursor for `findUsuariosPaginated`. base64url (NOT plain
 * base64) because cursors appear in URLs and must be URL-safe without
 * additional escaping. Format is JSON of `UsuarioPaginadoCursor` — the
 * shape is opaque to clients; servers can change it without coordination.
 */
export function encodeUsuariosPaginadosCursor(cursor: UsuarioPaginadoCursor): string {
  const json = JSON.stringify({ sortValue: cursor.sortValue, idUsuario: cursor.idUsuario });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

/**
 * Decode a previously-issued cursor. Throws `Error('Invalid pagination
 * cursor: ...')` on malformed input. Adapters MUST surface this as-is so
 * callers can distinguish a client/server cursor corruption from a normal
 * empty-page condition (which returns `nextCursor: null`).
 */
export function decodeUsuariosPaginadosCursor(cursor: string): UsuarioPaginadoCursor {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('cursor payload is not an object');
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sortValue !== 'string' || typeof obj.idUsuario !== 'string') {
      throw new Error('cursor missing required string fields sortValue / idUsuario');
    }
    return { sortValue: obj.sortValue, idUsuario: obj.idUsuario };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid pagination cursor: ${cause}`);
  }
}

/**
 * Extract the string sortValue for the given `sortBy` column from a
 * Usuario row. Used by both the memory adapter (to build cursors after
 * sorting) and conformance tests (to predict cursor contents).
 */
export function usuarioSortValue(usuario: Usuario, sortBy: UsuarioPaginadoSortBy): string {
  switch (sortBy) {
    case 'criadoEm':
      return usuario.criadoEm.toISOString();
    case 'email':
      return usuario.email;
    case 'nomeExibicao':
      return usuario.nomeExibicao;
  }
}
