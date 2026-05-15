import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UserRepositoryMemory } from '../../src/adapters/user-repository.memory.js';
import { UserEmailAlreadyExistsError } from '../../src/errors/user-email-already-exists.error.js';

const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('UserRepositoryMemory', () => {
  it('persists registration and resolves by id and email', async () => {
    const repo = new UserRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    const user = {
      id: userId,
      accountId,
      email: 'owner@example.com',
      displayName: 'Owner',
      createdAt: fixedDate,
    };
    const account = {
      id: accountId,
      userId,
      permissions: ['campaign:admin'] as const,
      createdAt: fixedDate,
    };
    const credential = { userId, simulatedPassword: 'stub-secret' };

    await repo.saveRegistration({ user, account, credential });

    expect(await repo.findUserById(userId)).toEqual(user);
    expect(await repo.findUserByEmail('owner@example.com')).toEqual(user);
    expect(await repo.findAccountById(accountId)).toEqual(account);
    expect(await repo.findCredentialByUserId(userId)).toEqual(credential);
  });

  it('throws UserEmailAlreadyExistsError on duplicate email', async () => {
    const repo = new UserRepositoryMemory();
    const bundle = (uid: string, aid: string, email: string) => ({
      user: {
        id: uid,
        accountId: aid,
        email,
        displayName: 'A',
        createdAt: fixedDate,
      },
      account: {
        id: aid,
        userId: uid,
        permissions: ['campaign:admin'] as const,
        createdAt: fixedDate,
      },
      credential: { userId: uid, simulatedPassword: 'p' },
    });

    const u1 = randomUUID();
    const a1 = randomUUID();
    await repo.saveRegistration(bundle(u1, a1, 'dup@example.com'));

    const u2 = randomUUID();
    const a2 = randomUUID();
    await expect(repo.saveRegistration(bundle(u2, a2, 'dup@example.com'))).rejects.toThrow(
      UserEmailAlreadyExistsError,
    );
  });

  it('updates display name', async () => {
    const repo = new UserRepositoryMemory();
    const userId = randomUUID();
    const accountId = randomUUID();
    await repo.saveRegistration({
      user: {
        id: userId,
        accountId,
        email: 'x@example.com',
        displayName: 'Old',
        createdAt: fixedDate,
      },
      account: {
        id: accountId,
        userId,
        permissions: ['campaign:admin'] as const,
        createdAt: fixedDate,
      },
      credential: { userId, simulatedPassword: 'p' },
    });

    await repo.updateUserDisplayName(userId, 'New Name');
    const loaded = await repo.findUserById(userId);
    expect(loaded?.displayName).toBe('New Name');
  });
});
