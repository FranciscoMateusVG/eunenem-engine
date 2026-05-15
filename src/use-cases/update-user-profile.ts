import { SpanStatusCode } from '@opentelemetry/api';
import type { UserRepository } from '../adapters/user-repository.js';
import type { UpdateUserProfileInput, User } from '../domain/user.js';
import { UpdateUserProfileInputSchema } from '../domain/user.js';
import { UserInvalidInputError } from '../errors/user-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface UpdateUserProfileDeps {
  readonly userRepository: UserRepository;
  readonly observability: Observability;
}

/**
 * Atualiza o nome de exibição (perfil) do utilizador.
 */
export async function updateUserProfile(
  deps: UpdateUserProfileDeps,
  input: UpdateUserProfileInput,
): Promise<User> {
  const { userRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('updateUserProfile', async (span) => {
    try {
      const parsed = UpdateUserProfileInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UserInvalidInputError(message);
      }

      const { userId, displayName } = parsed.data;

      span.setAttribute('user.id', userId);

      const existing = await userRepository.findUserById(userId);
      if (!existing) {
        throw new UserInvalidInputError('User not found');
      }

      await userRepository.updateUserDisplayName(userId, displayName);

      const updated: User = {
        ...existing,
        displayName,
      };

      logger.info('user.profile.updated', { userId });

      span.setStatus({ code: SpanStatusCode.OK });
      return updated;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
