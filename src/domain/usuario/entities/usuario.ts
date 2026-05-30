import type { EmailUsuario } from '../value-objects/email-usuario.js';
import type { IdContaUsuario, IdPlataformaReferencia, IdUsuario } from '../value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../value-objects/nome-exibicao-usuario.js';
import type { Permissao } from '../value-objects/permissao.js';

/**
 * @aggregateRoot Usuario (BC Usuário)
 *
 * Identity record of an admin. Owns the linked `Conta` (1:1). Persisted as
 * a unit via `UsuarioRepository.saveRegistroDomain({usuario, conta})`.
 *
 * Belongs to exactly one Plataforma (multi-tenant boundary). Email
 * uniqueness is composite — `(idPlataforma, email)` — so the same person
 * can register on eunenem AND eucasei as two separate `Usuario` rows.
 *
 * `Conta` is an **entity inside this aggregate** — it has its own identity
 * (id / idUsuario) but is loaded and saved with the Usuario root, never
 * independently.
 *
 * **Auth credentials live OUTSIDE the aggregate** (aperture-ibbet) — they
 * are stored by the `AuthService` adapter (in-memory today,
 * BetterAuth-backed via aperture-g7f68 next). The domain Usuario aggregate
 * is auth-implementation-agnostic.
 *
 * `contaTemPermissao` is a pure domain predicate that lives here because
 * the permission check is a property of the Conta entity.
 */
export interface Usuario {
  readonly id: IdUsuario;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly idConta: IdContaUsuario;
  readonly email: EmailUsuario;
  readonly nomeExibicao: NomeExibicaoUsuario;
  readonly criadoEm: Date;
}

/** @entity Conta (within Usuario aggregate) — permissions and admin grouping. */
export interface Conta {
  readonly id: IdContaUsuario;
  readonly idUsuario: IdUsuario;
  readonly permissoes: readonly Permissao[];
  readonly criadaEm: Date;
}

/** Verifica se a conta concede a permissão pedida. */
export function contaTemPermissao(conta: Conta, permissao: Permissao): boolean {
  return conta.permissoes.includes(permissao);
}
