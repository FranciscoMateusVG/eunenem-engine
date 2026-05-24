import type { Sessao } from '../../domain/usuario/entities/sessao.js';
import type { TokenSessao } from '../../domain/usuario/value-objects/token-sessao.js';

/**
 * Sessões autenticadas simuladas (porta).
 */
export interface SessaoUsuarioRepository {
  save(sessao: Sessao): Promise<void>;
  findByToken(token: TokenSessao): Promise<Sessao | undefined>;
}
