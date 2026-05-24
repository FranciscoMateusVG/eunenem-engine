import type { IdContaUsuario } from '../value-objects/ids.js';
import type { TokenSessao } from '../value-objects/token-sessao.js';

/**
 * @aggregateRoot Sessao (BC Usuário)
 *
 * Opaque session bound to a Conta with an expiry. The `token` is the natural
 * identity. Persisted via `SessaoUsuarioRepository`.
 *
 * `sessaoExpirada` is a pure predicate that lives here because expiration is
 * an intrinsic property of the session.
 */
export interface Sessao {
  readonly token: TokenSessao;
  readonly idConta: IdContaUsuario;
  readonly expiraEm: Date;
}

/** Verifica se a sessão já expirou (regra pura). */
export function sessaoExpirada(sessao: Sessao, agora: Date): boolean {
  return agora.getTime() >= sessao.expiraEm.getTime();
}
