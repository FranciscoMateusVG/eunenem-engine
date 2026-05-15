import { describe, expect, it } from 'vitest';
import {
  isUserSessionExpired,
  UserEmailSchema,
  userAccountHasPermission,
} from '../../src/domain/user.js';

describe('userAccountHasPermission', () => {
  it('returns true when permission is present', () => {
    const account = {
      id: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      permissions: ['campaign:admin'] as const,
      createdAt: new Date(),
    };
    expect(userAccountHasPermission(account, 'campaign:admin')).toBe(true);
  });

  it('returns false when permission is missing', () => {
    const account = {
      id: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      permissions: [] as readonly 'campaign:admin'[],
      createdAt: new Date(),
    };
    expect(userAccountHasPermission(account, 'campaign:admin')).toBe(false);
  });
});

describe('isUserSessionExpired', () => {
  it('returns false before expiresAt', () => {
    const session = {
      token: 'x'.repeat(32),
      accountId: '00000000-0000-4000-8000-000000000001',
      expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    expect(isUserSessionExpired(session, new Date('2026-05-01T00:00:00.000Z'))).toBe(false);
  });

  it('returns true at or after expiresAt', () => {
    const session = {
      token: 'x'.repeat(32),
      accountId: '00000000-0000-4000-8000-000000000001',
      expiresAt: new Date('2026-05-01T00:00:00.000Z'),
    };
    expect(isUserSessionExpired(session, new Date('2026-05-01T00:00:00.000Z'))).toBe(true);
    expect(isUserSessionExpired(session, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);
  });
});

describe('UserEmailSchema', () => {
  it('normalizes email to lowercase', () => {
    expect(UserEmailSchema.parse('  Test@Example.COM ')).toBe('test@example.com');
  });
});
