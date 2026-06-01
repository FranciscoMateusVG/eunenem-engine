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
