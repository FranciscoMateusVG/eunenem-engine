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
}
