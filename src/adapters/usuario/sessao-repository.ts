import type { Sessao, TokenSessao } from '../../domain/usuario/usuario.js';

/**
 * Sessões autenticadas simuladas (porta).
 */
export interface SessaoUsuarioRepository {
  save(sessao: Sessao): Promise<void>;
  findByToken(token: TokenSessao): Promise<Sessao | undefined>;
}
