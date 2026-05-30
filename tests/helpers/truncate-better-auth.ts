import type { Database } from '../../src/adapters/database.js';

/**
 * Truncate BetterAuth tables between tests (aperture-g7f68).
 *
 * `sessions.user_id` + `accounts.user_id` have `ON DELETE CASCADE`
 * against `users.id` so deleting users alone would cascade; deleting
 * each explicitly is faster + clearer + survives future FK changes.
 * `verifications` + `rate_limit` are unrelated tables — also reset.
 */
export async function truncateBetterAuthTables(db: Database): Promise<void> {
  await db.deleteFrom('rate_limit').execute();
  await db.deleteFrom('verifications').execute();
  await db.deleteFrom('sessions').execute();
  await db.deleteFrom('accounts').execute();
  await db.deleteFrom('users').execute();
}
