import { randomBytes } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { UserRepository } from '../adapters/user-repository.js';
import type { UserSessionRepository } from '../adapters/user-session-repository.js';
import type { CreateUserSessionInput, UserSession } from '../domain/user.js';
import { CreateUserSessionInputSchema, SessionTokenSchema } from '../domain/user.js';
import { UserInvalidInputError } from '../errors/user-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface CreateUserSessionDeps {
  readonly userRepository: UserRepository;
  readonly sessionRepository: UserSessionRepository;
  readonly clock: () => Date;
  /** Duração da sessão simulada (ms). */
  readonly sessionTtlMs: number;
  readonly observability: Observability;
}

function newOpaqueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Cria uma sessão fake após validar email + palavra-passe simulada.
 */
export async function createUserSession(
  deps: CreateUserSessionDeps,
  input: CreateUserSessionInput,
): Promise<UserSession> {
  const { userRepository, sessionRepository, clock, sessionTtlMs, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('createUserSession', async (span) => {
    try {
      const parsed = CreateUserSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UserInvalidInputError(message);
      }

      const { email, simulatedPassword } = parsed.data;

      span.setAttribute('user.email.length', email.length);

      const user = await userRepository.findUserByEmail(email);
      const credential = user ? await userRepository.findCredentialByUserId(user.id) : undefined;

      if (!user || !credential || credential.simulatedPassword !== simulatedPassword) {
        throw new UserInvalidInputError('Invalid email or simulated password');
      }

      const now = clock();
      const rawToken = newOpaqueSessionToken();
      const token = SessionTokenSchema.parse(rawToken);

      const session: UserSession = {
        token,
        accountId: user.accountId,
        expiresAt: new Date(now.getTime() + sessionTtlMs),
      };

      await sessionRepository.save(session);

      logger.info('user.session.created', {
        userId: user.id,
        accountId: user.accountId,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return session;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
