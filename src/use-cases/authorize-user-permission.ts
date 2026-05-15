import { SpanStatusCode } from '@opentelemetry/api';
import type { UserRepository } from '../adapters/user-repository.js';
import type { UserSessionRepository } from '../adapters/user-session-repository.js';
import type { AuthorizeUserPermissionInput } from '../domain/user.js';
import {
  AuthorizeUserPermissionInputSchema,
  isUserSessionExpired,
  userAccountHasPermission,
} from '../domain/user.js';
import { UserForbiddenError } from '../errors/user-forbidden.error.js';
import { UserSessionInvalidError } from '../errors/user-session-invalid.error.js';
import type { Observability } from '../observability/observability.js';

export interface AuthorizeUserPermissionDeps {
  readonly userRepository: UserRepository;
  readonly sessionRepository: UserSessionRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Verifica se o token de sessão é válido e se a conta tem a permissão pedida.
 */
export async function authorizeUserPermission(
  deps: AuthorizeUserPermissionDeps,
  input: AuthorizeUserPermissionInput,
): Promise<void> {
  const { userRepository, sessionRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('authorizeUserPermission', async (span) => {
    try {
      const parsed = AuthorizeUserPermissionInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UserSessionInvalidError(message);
      }

      const { token, permission } = parsed.data;

      const session = await sessionRepository.findByToken(token);
      if (!session) {
        throw new UserSessionInvalidError('Unknown session token');
      }

      if (isUserSessionExpired(session, clock())) {
        throw new UserSessionInvalidError('Session expired');
      }

      const account = await userRepository.findAccountById(session.accountId);
      if (!account) {
        throw new UserSessionInvalidError('Account not found for session');
      }

      if (!userAccountHasPermission(account, permission)) {
        throw new UserForbiddenError(permission);
      }

      logger.info('user.permission.authorized', {
        accountId: account.id,
        permission,
      });

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
