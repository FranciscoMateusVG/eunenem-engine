import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Database } from '../database.js';

import {
  LIFECYCLE_EMAIL_TYPES,
  type LifecycleEmailPreferences,
  type LifecycleEmailPreferencesRepository,
  type LifecycleEmailType,
} from './lifecycle-email-preferences.js';

export {
  LIFECYCLE_EMAIL_TYPES,
  type LifecycleEmailPreferences,
  type LifecycleEmailType,
} from './lifecycle-email-preferences.js';

export class LifecycleEmailPreferencesPostgres implements LifecycleEmailPreferencesRepository {
  constructor(private readonly db: Database) {}

  async getPreferences(userId: string, tenantId: string): Promise<LifecycleEmailPreferences> {
    return lifecycleSpan('db.lifecycle_email.getPreferences', async () => {
      const result: LifecycleEmailPreferences = {
        welcome: true,
        list_ready: true,
        event_reminder: true,
        payment_received: true,
        new_message: true,
        presence_confirmed: true,
      };
      const { rows } = await sql<{ type: LifecycleEmailType; enabled: boolean }>`
      SELECT type, enabled FROM lifecycle_email_preferences WHERE user_id=${userId} AND tenant_id=${tenantId}
    `.execute(this.db);
      for (const row of rows) result[row.type] = row.enabled;
      return result;
    });
  }

  async setPreferences(
    userId: string,
    tenantId: string,
    patch: Partial<LifecycleEmailPreferences>,
  ): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.setPreferences', async () => {
      await this.db.transaction().execute(async (trx) => {
        for (const type of LIFECYCLE_EMAIL_TYPES) {
          if (typeof patch[type] !== 'boolean') continue;
          await sql`INSERT INTO lifecycle_email_preferences(user_id, tenant_id, type, enabled)
          VALUES (${userId}, ${tenantId}, ${type}, ${patch[type]})
          ON CONFLICT (tenant_id, user_id, type) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`.execute(
            trx,
          );
        }
      });
    });
  }
}

async function lifecycleSpan<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return trace.getTracer('frame').startActiveSpan(name, async (span) => {
    span.setAttributes({ 'db.system': 'postgresql', 'db.collection.name': 'lifecycle_email' });
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(new Error('Lifecycle email operation failed'));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
