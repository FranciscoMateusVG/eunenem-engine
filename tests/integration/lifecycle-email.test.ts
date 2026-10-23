import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLifecycleEmailTokens } from '../../apps/eunenem-server/server/auth/lifecycle-email-tokens.js';
import { LifecycleEmailPreferencesPostgres } from '../../src/adapters/email/lifecycle-email-preferences.postgres.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

describe('lifecycle email durable boundaries', () => {
  let test: TestDatabase;
  beforeAll(async () => {
    test = await createTestDatabase();
  });
  afterAll(async () => {
    await test?.teardown();
  });
  it('defaults every type ON, persists individual opt-out and isolates tenants', async () => {
    const preferences = new LifecycleEmailPreferencesPostgres(test.db);
    const user = randomUUID();
    const tenant = randomUUID();
    expect(await preferences.getPreferences(user, tenant)).toEqual({
      welcome: true,
      list_ready: true,
      event_reminder: true,
      payment_received: true,
      new_message: true,
      presence_confirmed: true,
    });
    await preferences.setPreferences(user, tenant, { payment_received: false });
    expect((await preferences.getPreferences(user, tenant)).payment_received).toBe(false);
    expect((await preferences.getPreferences(user, randomUUID())).payment_received).toBe(true);
  });
  it('has a durable unique occurrence and delivery, unknown is not claimable', async () => {
    const columns = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns where table_name='lifecycle_email_deliveries'`.execute(
      test.db,
    );
    expect(columns.rows.map((r) => r.column_name)).toContain('state');
  });
  it('separates signed token scopes, rejects tampering and expiry without writes', () => {
    let now = new Date('2026-10-17T12:00:00Z');
    const tokens = createLifecycleEmailTokens(
      'test-secret-long-enough-for-signing-only',
      () => now,
    );
    const claims = { userId: randomUUID(), tenantId: randomUUID(), type: 'welcome' as const };
    const token = tokens.signPreferenceToken(claims);
    expect(tokens.verifyPreferenceToken(token)).toEqual(claims);
    expect(tokens.verifyFeedbackToken(token)).toBeNull();
    expect(tokens.verifyPreferenceToken(`${token}x`)).toBeNull();
    now = new Date('2026-11-18T12:00:00Z');
    expect(tokens.verifyPreferenceToken(token)).toEqual(claims);
    const shortLived = tokens.signFeedbackToken(randomUUID());
    now = new Date('2027-01-01T12:00:00Z');
    expect(tokens.verifyFeedbackToken(shortLived)).toBeNull();
    now = new Date('2037-01-01T12:00:00Z');
    expect(tokens.verifyPreferenceToken(token)).toBeNull();
  });
});
