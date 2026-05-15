import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UserRepositoryMemory } from '../../src/adapters/user-repository.memory.js';
import { UserSessionRepositoryMemory } from '../../src/adapters/user-session-repository.memory.js';
import { SessionTokenSchema } from '../../src/domain/user.js';
import { UserEmailAlreadyExistsError } from '../../src/errors/user-email-already-exists.error.js';
import { UserForbiddenError } from '../../src/errors/user-forbidden.error.js';
import { UserInvalidInputError } from '../../src/errors/user-invalid-input.error.js';
import { UserSessionInvalidError } from '../../src/errors/user-session-invalid.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { authorizeUserPermission } from '../../src/use-cases/authorize-user-permission.js';
import { createUserSession } from '../../src/use-cases/create-user-session.js';
import { registerUserAccount } from '../../src/use-cases/register-user-account.js';
import { updateUserProfile } from '../../src/use-cases/update-user-profile.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

describe('registerUserAccount', () => {
  it('registers user, account and simulated credential', async () => {
    const userRepository = new UserRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();

    const result = await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId,
        accountId,
        email: 'creator@example.com',
        displayName: 'Campaign Owner',
        simulatedPassword: 'not-a-real-password',
      },
    );

    expect(result.user.id).toBe(userId);
    expect(result.account.id).toBe(accountId);
    expect(result.account.permissions).toEqual(['campaign:admin']);
    expect(await userRepository.findUserByEmail('creator@example.com')).toEqual(result.user);
  });

  it('throws UserInvalidInputError on invalid email', async () => {
    const userRepository = new UserRepositoryMemory();
    await expect(
      registerUserAccount(
        { userRepository, clock, observability: silentObservability },
        {
          userId: randomUUID(),
          accountId: randomUUID(),
          email: 'not-an-email',
          displayName: 'X',
          simulatedPassword: 'p',
        },
      ),
    ).rejects.toThrow(UserInvalidInputError);
  });

  it('throws UserEmailAlreadyExistsError when email is taken', async () => {
    const userRepository = new UserRepositoryMemory();
    const email = 'taken@example.com';
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId: randomUUID(),
        accountId: randomUUID(),
        email,
        displayName: 'One',
        simulatedPassword: 'p',
      },
    );

    await expect(
      registerUserAccount(
        { userRepository, clock, observability: silentObservability },
        {
          userId: randomUUID(),
          accountId: randomUUID(),
          email,
          displayName: 'Two',
          simulatedPassword: 'p',
        },
      ),
    ).rejects.toThrow(UserEmailAlreadyExistsError);
  });
});

describe('updateUserProfile', () => {
  it('updates display name', async () => {
    const userRepository = new UserRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId,
        accountId,
        email: 'u@example.com',
        displayName: 'Before',
        simulatedPassword: 'p',
      },
    );

    const updated = await updateUserProfile(
      { userRepository, observability: silentObservability },
      { userId, displayName: 'After' },
    );

    expect(updated.displayName).toBe('After');
  });

  it('throws when user is missing', async () => {
    const userRepository = new UserRepositoryMemory();
    await expect(
      updateUserProfile(
        { userRepository, observability: silentObservability },
        { userId: randomUUID(), displayName: 'Ghost' },
      ),
    ).rejects.toThrow(UserInvalidInputError);
  });

  it('throws UserInvalidInputError on invalid profile input', async () => {
    const userRepository = new UserRepositoryMemory();
    await expect(
      updateUserProfile(
        { userRepository, observability: silentObservability },
        { userId: randomUUID(), displayName: '' },
      ),
    ).rejects.toThrow(UserInvalidInputError);
  });
});

describe('createUserSession', () => {
  it('creates a session when simulated password matches', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const email = 'login@example.com';
    const password = 'secret-stub';
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId: randomUUID(),
        accountId: randomUUID(),
        email,
        displayName: 'L',
        simulatedPassword: password,
      },
    );

    const session = await createUserSession(
      {
        userRepository,
        sessionRepository,
        clock,
        sessionTtlMs: 60_000,
        observability: silentObservability,
      },
      { email, simulatedPassword: password },
    );

    expect(session.token.length).toBeGreaterThanOrEqual(32);
    expect(session.expiresAt.getTime()).toBe(fixedDate.getTime() + 60_000);
  });

  it('throws on bad credentials', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId: randomUUID(),
        accountId: randomUUID(),
        email: 'only@example.com',
        displayName: 'L',
        simulatedPassword: 'right',
      },
    );

    await expect(
      createUserSession(
        {
          userRepository,
          sessionRepository,
          clock,
          sessionTtlMs: 60_000,
          observability: silentObservability,
        },
        { email: 'only@example.com', simulatedPassword: 'wrong' },
      ),
    ).rejects.toThrow(UserInvalidInputError);
  });

  it('throws UserInvalidInputError on invalid session input', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    await expect(
      createUserSession(
        {
          userRepository,
          sessionRepository,
          clock,
          sessionTtlMs: 60_000,
          observability: silentObservability,
        },
        { email: 'bad-email', simulatedPassword: 'x' },
      ),
    ).rejects.toThrow(UserInvalidInputError);
  });
});

describe('authorizeUserPermission', () => {
  it('authorizes when session is valid and permission exists', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId,
        accountId,
        email: 'auth@example.com',
        displayName: 'A',
        simulatedPassword: 'p',
      },
    );

    const { token } = await createUserSession(
      {
        userRepository,
        sessionRepository,
        clock,
        sessionTtlMs: 60_000,
        observability: silentObservability,
      },
      { email: 'auth@example.com', simulatedPassword: 'p' },
    );

    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token, permission: 'campaign:admin' },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws UserSessionInvalidError when token unknown', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const token = SessionTokenSchema.parse(randomBytes(32).toString('base64url'));

    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token, permission: 'campaign:admin' },
      ),
    ).rejects.toThrow(UserSessionInvalidError);
  });

  it('throws UserSessionInvalidError on malformed input token', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token: 'short', permission: 'campaign:admin' },
      ),
    ).rejects.toThrow(UserSessionInvalidError);
  });

  it('throws UserSessionInvalidError when account is missing for session', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const token = SessionTokenSchema.parse(randomBytes(32).toString('base64url'));
    await sessionRepository.save({
      token,
      accountId: randomUUID(),
      expiresAt: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token, permission: 'campaign:admin' },
      ),
    ).rejects.toThrow(UserSessionInvalidError);
  });

  it('throws UserSessionInvalidError when session expired', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    await registerUserAccount(
      { userRepository, clock, observability: silentObservability },
      {
        userId,
        accountId,
        email: 'exp@example.com',
        displayName: 'E',
        simulatedPassword: 'p',
      },
    );

    const token = SessionTokenSchema.parse(randomBytes(32).toString('base64url'));
    await sessionRepository.save({
      token,
      accountId,
      expiresAt: new Date(fixedDate.getTime() - 1),
    });

    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token, permission: 'campaign:admin' },
      ),
    ).rejects.toThrow(UserSessionInvalidError);
  });

  it('throws UserForbiddenError when permission missing on account', async () => {
    const userRepository = new UserRepositoryMemory();
    const sessionRepository = new UserSessionRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    await userRepository.saveRegistration({
      user: {
        id: userId,
        accountId,
        email: 'noperm@example.com',
        displayName: 'N',
        createdAt: fixedDate,
      },
      account: {
        id: accountId,
        userId,
        permissions: [],
        createdAt: fixedDate,
      },
      credential: { userId, simulatedPassword: 'p' },
    });

    const token = SessionTokenSchema.parse(randomBytes(32).toString('base64url'));
    await sessionRepository.save({
      token,
      accountId,
      expiresAt: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      authorizeUserPermission(
        { userRepository, sessionRepository, clock, observability: silentObservability },
        { token, permission: 'campaign:admin' },
      ),
    ).rejects.toThrow(UserForbiddenError);
  });
});
