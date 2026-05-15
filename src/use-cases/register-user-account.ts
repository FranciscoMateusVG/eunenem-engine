import { SpanStatusCode } from '@opentelemetry/api';
import type { UserRepository } from '../adapters/user-repository.js';
import type { RegisterUserAccountInput, User, UserAccount } from '../domain/user.js';
import { DEFAULT_USER_PERMISSIONS, RegisterUserAccountInputSchema } from '../domain/user.js';
import { UserInvalidInputError } from '../errors/user-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface RegisterUserAccountDeps {
  readonly userRepository: UserRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface RegisterUserAccountResult {
  readonly user: User;
  readonly account: UserAccount;
}

/**
 * Regista utilizador, conta administrativa (1:1), perfil inicial e credencial simulada.
 */
export async function registerUserAccount(
  deps: RegisterUserAccountDeps,
  input: RegisterUserAccountInput,
): Promise<RegisterUserAccountResult> {
  const { userRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registerUserAccount', async (span) => {
    try {
      const parsed = RegisterUserAccountInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UserInvalidInputError(message);
      }

      const data = parsed.data;
      const createdAt = clock();

      span.setAttribute('user.id', data.userId);
      span.setAttribute('user.account.id', data.accountId);
      span.setAttribute('user.email.length', data.email.length);

      const user: User = {
        id: data.userId,
        accountId: data.accountId,
        email: data.email,
        displayName: data.displayName,
        createdAt,
      };

      const account: UserAccount = {
        id: data.accountId,
        userId: data.userId,
        permissions: DEFAULT_USER_PERMISSIONS,
        createdAt,
      };

      const credential = {
        userId: data.userId,
        simulatedPassword: data.simulatedPassword,
      };

      await userRepository.saveRegistration({ user, account, credential });

      logger.info('user.account.registered', {
        userId: user.id,
        accountId: account.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { user, account };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
