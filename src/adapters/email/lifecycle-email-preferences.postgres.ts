import { sql } from 'kysely';
import type { Database } from '../database.js';

export const LIFECYCLE_EMAIL_TYPES = ['welcome', 'list_ready', 'event_reminder', 'payment_received'] as const;
export type LifecycleEmailType = (typeof LIFECYCLE_EMAIL_TYPES)[number];
export type LifecycleEmailPreferences = Record<LifecycleEmailType, boolean>;

export class LifecycleEmailPreferencesPostgres {
  constructor(private readonly db: Database) {}

  async getPreferences(userId: string, tenantId: string): Promise<LifecycleEmailPreferences> {
    const result: LifecycleEmailPreferences = { welcome: true, list_ready: true, event_reminder: true, payment_received: true };
    const { rows } = await sql<{ type: LifecycleEmailType; enabled: boolean }>`
      SELECT type, enabled FROM lifecycle_email_preferences WHERE user_id=${userId} AND tenant_id=${tenantId}
    `.execute(this.db);
    for (const row of rows) result[row.type] = row.enabled;
    return result;
  }

  async setPreferences(userId: string, tenantId: string, patch: Partial<LifecycleEmailPreferences>): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (const type of LIFECYCLE_EMAIL_TYPES) {
        if (typeof patch[type] !== 'boolean') continue;
        await sql`INSERT INTO lifecycle_email_preferences(user_id, tenant_id, type, enabled)
          VALUES (${userId}, ${tenantId}, ${type}, ${patch[type]})
          ON CONFLICT (tenant_id, user_id, type) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()` .execute(trx);
      }
    });
  }
}
