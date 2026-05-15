import type { SessionToken, UserSession } from '../domain/user.js';

/**
 * Sessões autenticadas simuladas (porta).
 */
export interface UserSessionRepository {
  save(session: UserSession): Promise<void>;
  findByToken(token: SessionToken): Promise<UserSession | undefined>;
}
