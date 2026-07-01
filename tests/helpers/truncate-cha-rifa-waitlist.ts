import type { Database } from '../../src/adapters/database.js';

/** Truncate cha_rifa_waitlist between integration tests. */
export async function truncateChaRifaWaitlist(db: Database): Promise<void> {
  await db.deleteFrom('cha_rifa_waitlist').execute();
}
