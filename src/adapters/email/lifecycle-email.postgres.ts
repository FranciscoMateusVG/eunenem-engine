import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../database.js';
import type { DB } from '../db-types.generated.js';
import type { LifecycleEmailType } from './lifecycle-email-preferences.js';
import type {
  Delivery,
  LifecycleCandidates,
  LifecycleEmailRepository,
  Recipient,
  Snapshot,
} from './lifecycle-email-repository.js';

export class LifecycleEmailRepositoryPostgres implements LifecycleEmailRepository {
  constructor(private readonly db: Database) {}
  async initialize(launchAt: Date, now: Date): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.initialize', async () => {
      await this.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(831116046)`.execute(trx);
        const { rows } = await sql<{
          launch_at: Date;
        }>`SELECT launch_at FROM lifecycle_email_rollout WHERE singleton`.execute(trx);
        if (rows[0]) {
          if (rows[0].launch_at.getTime() !== launchAt.getTime())
            throw new Error('Lifecycle email launch instant is immutable');
        } else {
          if (launchAt.getTime() < now.getTime() - 5 * 60_000)
            throw new Error('First lifecycle launch instant cannot be in the past');
          await sql`INSERT INTO lifecycle_email_rollout(singleton,launch_at) VALUES(true,${launchAt})`.execute(
            trx,
          );
        }
      });
    });
  }
  async provisioningStarted(userId: string, campaignId: string, giftCount: number): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.provisioningStarted', async () => {
      await sql`INSERT INTO lifecycle_email_provisioned(user_id,campaign_id,expected_gift_count)
      VALUES(${userId},${campaignId},${giftCount}) ON CONFLICT DO NOTHING`.execute(this.db);
    });
  }
  async provisioningCompleted(
    userId: string,
    campaignId: string,
    giftCount: number,
    now: Date,
  ): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.provisioningCompleted', async () => {
      await sql`INSERT INTO lifecycle_email_provisioned(user_id,campaign_id,expected_gift_count,completed_at)
      VALUES(${userId},${campaignId},${giftCount},${now}) ON CONFLICT(user_id) DO UPDATE SET completed_at=EXCLUDED.completed_at`.execute(
        this.db,
      );
    });
  }
  async recipients(
    launchAt: Date,
    campaignId: string | null,
    userId?: string,
    ownerOnly = false,
    executor: Database | Transaction<DB> = this.db,
  ): Promise<Recipient[]> {
    return lifecycleSpan('db.lifecycle_email.recipients', async () => {
      const { rows } = await sql<Recipient>`
      SELECT DISTINCT ON (lower(trim(u.email))) u.id AS user_id,u.id_plataforma AS tenant_id,u.email,u.nome_exibicao AS name,u.slug,
        ${campaignId ? sql`p.papel='owner'` : sql`true`} AS owner
      FROM usuarios u JOIN users a ON a.id=u.id::text AND a.id_plataforma=u.id_plataforma
      JOIN lifecycle_email_provisioned provision ON provision.user_id=u.id AND provision.completed_at IS NOT NULL
      ${
        campaignId
          ? sql`JOIN campanha_administradores ca ON ca.id_usuario=u.id_conta AND ca.campanha_id=${campaignId}
        JOIN campanha_membros_permissoes p ON p.campanha_id=ca.campanha_id AND p.id_conta=ca.id_usuario
        JOIN campanhas c ON c.id=ca.campanha_id AND c.id_plataforma=u.id_plataforma`
          : sql``
      }
      WHERE a.email_verified=true AND lower(trim(a.email))=lower(trim(u.email)) AND u.desativado_em IS NULL
        AND a.created_at>=${launchAt} AND u.criado_em>=${launchAt}
        ${userId ? sql`AND u.id=${userId}` : sql``}
        ${campaignId ? sql`AND c.criada_em>=${launchAt} AND (p.papel='owner' ${ownerOnly ? sql`` : sql`OR 'extrato:ver'=ANY(p.permissoes)`})` : sql``}
      ORDER BY lower(trim(u.email)), ${campaignId ? sql`(p.papel='owner') DESC,` : sql``} u.id
    `.execute(executor);
      return rows;
    });
  }
  async admit(
    launchAt: Date,
    now: Date,
    type: LifecycleEmailType,
    subjectId: string,
    campaignId: string | null,
    occurredAt: Date,
    snapshot: Snapshot,
    ownerOnly: boolean,
    userId?: string,
  ): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.admit', async () => {
      await this.db.transaction().execute(async (trx) => {
        const recipients = await this.recipients(launchAt, campaignId, userId, ownerOnly, trx);
        const firstRecipient = recipients[0];
        if (!firstRecipient) return;
        const tenantId = firstRecipient.tenant_id;
        const { rows } = await sql<{
          id: string;
        }>`INSERT INTO lifecycle_email_events(id,tenant_id,type,subject_id,campaign_id,occurred_at,snapshot)
        VALUES(${randomUUID()},${tenantId},${type},${subjectId},${campaignId},${occurredAt},${JSON.stringify(snapshot)}::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`.execute(trx);
        let eventId = rows[0]?.id;
        if (!eventId && type === 'event_reminder') {
          // Date edits may replace an UNSENT reminder, never one accepted or
          // possibly accepted. Lock the occurrence against concurrent rearming.
          const existing = await sql<{
            id: string;
            snapshot: Snapshot;
          }>`SELECT id,snapshot FROM lifecycle_email_events
          WHERE tenant_id=${tenantId} AND type=${type} AND subject_id=${subjectId} FOR UPDATE`.execute(
            trx,
          );
          const previous = existing.rows[0];
          if (!previous) return;
          if (previous.snapshot.eventDate === snapshot.eventDate) {
            const restorable =
              await sql`SELECT 1 FROM lifecycle_email_deliveries WHERE event_id=${previous.id} AND state='suppressed' AND reason='event_date_changed'`.execute(
                trx,
              );
            if (!restorable.rows.length) return;
          }
          const unsafe =
            await sql`SELECT 1 FROM lifecycle_email_deliveries WHERE event_id=${previous.id}
          AND state IN ('sending','sent','unknown')`.execute(trx);
          if (unsafe.rows.length) return;
          eventId = previous.id;
          await sql`UPDATE lifecycle_email_events SET snapshot=${JSON.stringify(snapshot)}::jsonb,occurred_at=${occurredAt} WHERE id=${eventId}`.execute(
            trx,
          );
          await sql`UPDATE lifecycle_email_deliveries SET state='suppressed',reason='event_date_changed' WHERE event_id=${eventId}`.execute(
            trx,
          );
        }
        if (!eventId) return;
        for (const recipient of recipients) {
          await sql`INSERT INTO lifecycle_email_deliveries(id,event_id,tenant_id,user_id,type,next_attempt_at)
          VALUES(${randomUUID()},${eventId},${tenantId},${recipient.user_id},${type},${now})
          ON CONFLICT(event_id,user_id) DO UPDATE SET state='pending',reason=NULL,email_key=NULL,attempts=0,next_attempt_at=EXCLUDED.next_attempt_at`.execute(
            trx,
          );
        }
      });
    });
  }

  async paymentGifts(paymentId: string): Promise<{ name: string; quantity: number }[]> {
    return lifecycleSpan('db.lifecycle_email.paymentGifts', async () => {
      const { rows } = await sql<{
        name: string;
        quantity: number;
      }>`SELECT COALESCE(c.nome,'um presente da sua lista') AS name,i.quantidade AS quantity
      FROM intencao_items i LEFT JOIN contribuicoes c ON c.id=i.id_contribuicao
      WHERE i.id_pagamento=${paymentId} AND i.tipo='contribuicao' ORDER BY i.position LIMIT 100`.execute(
        this.db,
      );
      return rows;
    });
  }
  async recoverProvisioning(now: Date): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.recoverProvisioning', async () => {
      await sql`UPDATE lifecycle_email_provisioned p SET completed_at=${now}
      WHERE p.user_id IN (SELECT q.user_id FROM lifecycle_email_provisioned q
        WHERE q.completed_at IS NULL AND EXISTS(SELECT 1 FROM opcoes_contribuicao o WHERE o.campanha_id=q.campaign_id)
        AND (SELECT count(*) FROM contribuicoes g WHERE g.campanha_id=q.campaign_id)>=q.expected_gift_count LIMIT 100)`.execute(
        this.db,
      );
    });
  }
  async recoverStale(now: Date): Promise<number> {
    return lifecycleSpan('db.lifecycle_email.recoverStale', async () => {
      const result =
        await sql`UPDATE lifecycle_email_deliveries SET state='unknown',reason='worker_interrupted'
      WHERE state='sending' AND claimed_at<${new Date(now.getTime() - 15 * 60_000)}`.execute(
          this.db,
        );
      return Number(result.numAffectedRows ?? 0);
    });
  }
  async candidates(launchAt: Date, now: Date): Promise<LifecycleCandidates> {
    return lifecycleSpan('db.lifecycle_email.candidates', async () => {
      return this.db.transaction().execute(async (trx) => {
        // Durable keyset cursors let ineligible/corrupt rows remain recoverable
        // without permanently blocking later eligible accounts or payments.
        await sql`INSERT INTO lifecycle_email_scan_cursors(type) VALUES ('welcome'),('list_ready'),('event_reminder'),('payment_received') ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        const cursors = await sql<{
          type: LifecycleEmailType;
          last_id: string;
        }>`SELECT type,last_id FROM lifecycle_email_scan_cursors ORDER BY type FOR UPDATE`.execute(
          trx,
        );
        const cursor = (type: LifecycleEmailType) =>
          cursors.rows.find((r) => r.type === type)?.last_id ??
          '00000000-0000-0000-0000-000000000000';
        // Filter permanent cohort misses before LIMIT; cursors are only for
        // recoverable admission failures, not repeated historical-account sweeps.
        const eligibleOwner = sql`EXISTS (
          SELECT 1 FROM campanha_administradores ca
          JOIN campanha_membros_permissoes mp ON mp.campanha_id=ca.campanha_id AND mp.id_conta=ca.id_usuario AND mp.papel='owner'
          JOIN usuarios u ON u.id_conta=ca.id_usuario AND u.id_plataforma=c.id_plataforma
          JOIN users a ON a.id=u.id::text AND a.id_plataforma=u.id_plataforma
          JOIN lifecycle_email_provisioned provision ON provision.user_id=u.id AND provision.completed_at IS NOT NULL
          WHERE ca.campanha_id=c.id AND a.created_at>=${launchAt} AND u.criado_em>=${launchAt}
            AND a.email_verified AND u.desativado_em IS NULL AND lower(trim(a.email))=lower(trim(u.email))
        )`;
        const welcomes = await sql<{
          id: string;
          created_at: Date;
        }>`SELECT a.id,a.created_at FROM users a
        JOIN lifecycle_email_provisioned p ON p.user_id::text=a.id AND p.completed_at IS NOT NULL
        WHERE a.created_at>=${launchAt} AND a.email_verified AND a.id>${cursor('welcome')}::text
        AND NOT EXISTS(SELECT 1 FROM lifecycle_email_events e WHERE e.type='welcome' AND e.subject_id::text=a.id)
        ORDER BY a.id LIMIT 100`.execute(trx);
        const gifts = await sql<{
          campaign_id: string;
          occurred_at: Date;
        }>`SELECT f.* FROM lifecycle_email_first_gifts f JOIN campanhas c ON c.id=f.campaign_id
        WHERE ${eligibleOwner} AND c.criada_em>=${launchAt} AND f.occurred_at>=${launchAt} AND f.campaign_id>${cursor('list_ready')}::uuid
        AND NOT EXISTS(SELECT 1 FROM lifecycle_email_events e WHERE e.type='list_ready' AND e.subject_id=f.campaign_id)
        ORDER BY f.campaign_id LIMIT 100`.execute(trx);
        const reminders = await sql<{
          id_campanha: string;
          event_date: string;
        }>`SELECT v.id_campanha,to_char(v.data_hora AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS event_date
        FROM eventos v JOIN campanhas c ON c.id=v.id_campanha WHERE ${eligibleOwner} AND c.criada_em>=${launchAt} AND c.id>${cursor('event_reminder')}::uuid
        AND (v.data_hora AT TIME ZONE 'America/Sao_Paulo')::date=(${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date+5
        AND (${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::time>='09:00'::time
        AND NOT EXISTS(SELECT 1 FROM lifecycle_email_events e WHERE e.type='event_reminder' AND e.subject_id=c.id
          AND ((e.snapshot->>'eventDate'=to_char(v.data_hora AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD')
              AND NOT EXISTS(SELECT 1 FROM lifecycle_email_deliveries d WHERE d.event_id=e.id AND d.state='suppressed' AND d.reason='event_date_changed'))
            OR EXISTS(SELECT 1 FROM lifecycle_email_deliveries d WHERE d.event_id=e.id AND d.state IN ('sending','sent','unknown'))))
        ORDER BY c.id LIMIT 100`.execute(trx);
        const payments = await sql<{
          id: string;
        }>`SELECT p.id FROM pagamentos p JOIN campanhas c ON c.id=p.intencao_id_campanha
        WHERE ${eligibleOwner} AND p.status='aprovado' AND p.criado_em>=${launchAt} AND c.criada_em>=${launchAt} AND p.id>${cursor('payment_received')}::uuid
        AND p.atualizado_em<=${new Date(now.getTime() - 10 * 60_000)}
        AND NOT EXISTS(SELECT 1 FROM lifecycle_email_events e WHERE e.type='payment_received' AND e.subject_id=p.id)
        ORDER BY p.id LIMIT 100`.execute(trx);
        const advance = async (type: LifecycleEmailType, ids: string[]) => {
          await sql`UPDATE lifecycle_email_scan_cursors SET last_id=${ids.length === 100 ? (ids.at(-1) ?? '00000000-0000-0000-0000-000000000000') : '00000000-0000-0000-0000-000000000000'}::uuid WHERE type=${type}`.execute(
            trx,
          );
        };
        await advance(
          'welcome',
          welcomes.rows.map((r) => r.id),
        );
        await advance(
          'list_ready',
          gifts.rows.map((r) => r.campaign_id),
        );
        await advance(
          'event_reminder',
          reminders.rows.map((r) => r.id_campanha),
        );
        await advance(
          'payment_received',
          payments.rows.map((r) => r.id),
        );
        return {
          welcomes: welcomes.rows,
          gifts: gifts.rows,
          reminders: reminders.rows,
          payments: payments.rows,
        };
      });
    });
  }
  async claim(now: Date): Promise<Delivery | undefined> {
    return lifecycleSpan('db.lifecycle_email.claim', async () => {
      const { rows } = await sql<Delivery>`WITH candidate AS (
      SELECT d.id FROM lifecycle_email_deliveries d JOIN lifecycle_email_events e ON e.id=d.event_id
      WHERE d.state='pending' AND d.next_attempt_at<=${now}
      ORDER BY d.next_attempt_at,d.id FOR UPDATE OF e SKIP LOCKED LIMIT 1
    ), claimed AS (
      UPDATE lifecycle_email_deliveries d SET state='sending',claimed_at=${now},attempts=attempts+1 FROM candidate c WHERE d.id=c.id AND d.state='pending' RETURNING d.*
    ) SELECT e.*,d.id AS delivery_id,d.user_id,d.attempts FROM claimed d JOIN lifecycle_email_events e ON e.id=d.event_id`.execute(
        this.db,
      );
      return rows[0];
    });
  }
  async finish(id: string, state: string, reason: string, now: Date): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.finish', async () => {
      await sql`UPDATE lifecycle_email_deliveries SET state=${state},reason=${reason},sent_at=CASE WHEN ${state}='sent' THEN ${now} ELSE sent_at END
      WHERE id=${id} AND state='sending'`.execute(this.db);
    });
  }

  async reminderStillDue(
    campaignId: string | null,
    eventDate: string,
    now: Date,
  ): Promise<boolean> {
    return lifecycleSpan('db.lifecycle_email.reminderStillDue', async () => {
      const { rows } = await sql`SELECT 1 FROM eventos WHERE id_campanha=${campaignId}
      AND to_char(data_hora AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD')=${eventDate}
      AND (data_hora AT TIME ZONE 'America/Sao_Paulo')::date=(${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date+5
      AND (${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::time>='09:00'::time`.execute(
        this.db,
      );
      return rows.length > 0;
    });
  }
  async giftCount(campaignId: string | null): Promise<number | null> {
    return lifecycleSpan('db.lifecycle_email.giftCount', async () => {
      if (!campaignId) return null;
      const { rows } = await sql<{
        count: string;
      }>`SELECT count(*) AS count FROM contribuicoes WHERE campanha_id=${campaignId}`.execute(
        this.db,
      );
      return Number(rows[0]?.count ?? 0);
    });
  }
  async ownerName(campaignId: string | null): Promise<string | null> {
    return lifecycleSpan('db.lifecycle_email.ownerName', async () => {
      if (!campaignId) return null;
      const { rows } = await sql<{ name: string }>`SELECT u.nome_exibicao AS name FROM usuarios u
      JOIN campanha_administradores a ON a.id_usuario=u.id_conta JOIN campanha_membros_permissoes p ON p.campanha_id=a.campanha_id AND p.id_conta=a.id_usuario
      JOIN campanhas c ON c.id=a.campanha_id AND c.id_plataforma=u.id_plataforma WHERE a.campanha_id=${campaignId} AND p.papel='owner' LIMIT 1`.execute(
        this.db,
      );
      return rows[0]?.name ?? null;
    });
  }
  async reserveEmail(eventId: string, deliveryId: string, emailKey: string): Promise<boolean> {
    return lifecycleSpan('db.lifecycle_email.reserveEmail', async () => {
      return this.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM lifecycle_email_events WHERE id=${eventId} FOR UPDATE`.execute(
          trx,
        );
        const { rows } =
          await sql`SELECT id FROM lifecycle_email_deliveries WHERE event_id=${eventId} AND email_key=${emailKey} AND id<>${deliveryId}`.execute(
            trx,
          );
        if (rows.length) return false;
        await sql`UPDATE lifecycle_email_deliveries SET email_key=${emailKey} WHERE id=${deliveryId}`.execute(
          trx,
        );
        return true;
      });
    });
  }
  async retry(id: string, nextAttempt: Date): Promise<void> {
    return lifecycleSpan('db.lifecycle_email.retry', async () => {
      await sql`UPDATE lifecycle_email_deliveries SET state='pending',reason='smtp_rejected',next_attempt_at=${nextAttempt}
      WHERE id=${id} AND state='sending'`.execute(this.db);
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
