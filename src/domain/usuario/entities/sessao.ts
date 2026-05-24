import type { IdContaUsuario, IdPlataformaReferencia } from '../value-objects/ids.js';
import type { TokenSessao } from '../value-objects/token-sessao.js';

/**
 * @aggregateRoot Sessao (BC Usuário)
 *
 * Opaque session bound to a Conta with an expiry. The `token` is the natural
 * identity. Persisted via `SessaoUsuarioRepository`.
 *
 * Plataforma-scoped: `idPlataforma` is stamped at session creation. Carrying
 * it directly on the Sessão (instead of deriving it via Conta → Usuario)
 * makes "this session is for plataforma X" a first-class fact — downstream
 * authorization checks don't need a multi-hop lookup.
 *
 * `sessaoExpirada` is a pure predicate that lives here because expiration is
 * an intrinsic property of the session.
 */
export interface Sessao {
  readonly token: TokenSessao;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly idConta: IdContaUsuario;
  readonly expiraEm: Date;
}

/** Verifica se a sessão já expirou (regra pura). */
export function sessaoExpirada(sessao: Sessao, agora: Date): boolean {
  return agora.getTime() >= sessao.expiraEm.getTime();
}
