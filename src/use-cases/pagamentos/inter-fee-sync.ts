import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../adapters/database.js';
import {
  InterFeeReadError,
  type InterFeeReader,
} from '../../adapters/pagamentos/inter-processing-fee-reader.js';

/** One bounded day per tick; a failed/429 scan never advances or fabricates zero. */
export class InterFeeSync {
  constructor(
    private readonly db: Database,
    private readonly reader: InterFeeReader | null,
    private readonly platformId: string,
    private readonly clock: () => Date = () => new Date(),
    readonly enabled = false,
  ) {}
  /** Explicit operator preflight: counts only, no scan admission/provider calls. */
  async dryRun(): Promise<{ days: number; payments: number }> {
    const now = this.clock();
    const result = await sql<{ days: number; payments: number }>`SELECT
      GREATEST(0, ((${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - '2026-09-01'::date) + 1)::int AS days,
      (SELECT count(*)::int FROM pagamentos p JOIN campanhas c ON c.id=p.intencao_id_campanha
       WHERE c.id_plataforma=${this.platformId}::uuid AND p.intencao_metodo='pix'
       AND p.transacao_externa->>'provedor'='inter' AND p.criado_em>='2026-09-01T03:00:00Z'::timestamptz
       AND p.criado_em<=${now}) AS payments`.execute(this.db);
    return result.rows[0] ?? { days: 0, payments: 0 };
  }
  async run(): Promise<{ pending: boolean; imported: number }> {
    if (!this.enabled || !this.reader) return { pending: true, imported: 0 };
    const now = this.clock();
    const account = this.reader.accountRef;
    await sql`INSERT INTO provider_fee_inter_scans(account_ref,day,next_attempt_at)
      SELECT ${account},d::date,${now} FROM generate_series('2026-09-01'::date,
        (${now}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,'1 day'::interval) d
      ON CONFLICT DO NOTHING`.execute(this.db);
    // A persisted 429 on ANY day blocks this account before OAuth or statement HTTP.
    // Derive the cooldown from durable scan state, including exhausted days.
    const token = randomUUID();
    const rows = await sql<{ day: string; attempts: number }>`WITH due AS (
      SELECT account_ref,day FROM provider_fee_inter_scans WHERE account_ref=${account}
      AND NOT EXISTS (
        SELECT 1 FROM provider_fee_inter_scans cooldown
        WHERE cooldown.account_ref=${account} AND cooldown.last_reason='rate_limited'
          AND cooldown.next_attempt_at>${now}
      )
      AND attempts<8 AND next_attempt_at<=${now} AND (claimed_until IS NULL OR claimed_until<=${now})
      ORDER BY next_attempt_at,day LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE provider_fee_inter_scans s SET claim_token=${token}::uuid,
      claimed_until=${new Date(now.getTime() + 300_000)},attempts=attempts+1
      FROM due WHERE s.account_ref=due.account_ref AND s.day=due.day
      RETURNING s.day::text,s.attempts`.execute(this.db);
    const scan = rows.rows[0];
    if (!scan) return { pending: true, imported: 0 };
    const retryAt = new Date(
      now.getTime() + Math.min(86_400_000, 3_600_000 * 2 ** Math.min(scan.attempts - 1, 5)),
    );
    try {
      const page = await this.reader.readDay(scan.day);
      const environment = this.reader.environment;
      return await this.db.transaction().execute(async (trx) => {
        const owned =
          await sql`SELECT day FROM provider_fee_inter_scans WHERE account_ref=${account}
          AND day=${scan.day}::date AND claim_token=${token}::uuid FOR UPDATE`.execute(trx);
        if (!owned.rows.length) return { pending: true, imported: 0 };
        let imported = 0;
        for (const fee of page.fees) {
          const payments = await sql<{
            id: string;
          }>`SELECT p.id FROM pagamentos p JOIN campanhas c ON c.id=p.intencao_id_campanha
            WHERE c.id_plataforma=${this.platformId}::uuid AND p.intencao_metodo='pix'
            AND p.transacao_externa->>'provedor'='inter' AND p.intencao_e2e_external_ref=${fee.e2e}
            AND p.criado_em >= '2026-09-01T03:00:00Z'::timestamptz`.execute(trx);
          const paymentId = payments.rows.length === 1 ? payments.rows[0]?.id : null;
          const inserted = await sql`INSERT INTO provider_fee_events
            (provider,account_ref,environment,external_ref,payment_id,amount_cents,currency,occurred_at,observed_at,source,matching_ref)
            VALUES ('inter',${account},${environment},${fee.externalRef},${paymentId ?? null}::uuid,${fee.amountCents},'brl',${fee.occurredAt},${now},'inter_extrato_tarifa',${fee.e2e})
            ON CONFLICT(provider,account_ref,environment,external_ref) DO UPDATE SET
              payment_id=COALESCE(provider_fee_events.payment_id,EXCLUDED.payment_id)
            WHERE provider_fee_events.amount_cents=EXCLUDED.amount_cents AND provider_fee_events.matching_ref=EXCLUDED.matching_ref
              AND (provider_fee_events.payment_id IS NULL OR provider_fee_events.payment_id IS NOT DISTINCT FROM EXCLUDED.payment_id)
            RETURNING id`.execute(trx);
          if (!inserted.rows.length) throw new InterFeeReadError('invalid_fee');
          imported++;
        }
        if (page.invalid > 0) {
          // Only a fully paginated response reaches here. Preserve valid rows,
          // but do not mark this day successful or erase its finite retry budget.
          await sql`UPDATE provider_fee_inter_scans SET last_reason='invalid_fee',
            unmatched_count=${page.unmatched},next_attempt_at=${retryAt},claim_token=NULL,claimed_until=NULL
            WHERE account_ref=${account} AND day=${scan.day}::date AND claim_token=${token}::uuid`.execute(
            trx,
          );
          return { pending: true, imported };
        }
        await sql`UPDATE provider_fee_inter_scans SET last_success_at=${now},last_reason=NULL,attempts=0,
          unmatched_count=${page.unmatched},next_attempt_at=${new Date(now.getTime() + 86_400_000)},claim_token=NULL,claimed_until=NULL
          WHERE account_ref=${account} AND day=${scan.day}::date AND claim_token=${token}::uuid`.execute(
          trx,
        );
        return { pending: false, imported };
      });
    } catch (error) {
      const reason = error instanceof InterFeeReadError ? error.reason : 'unavailable';
      await sql`UPDATE provider_fee_inter_scans SET last_reason=${reason},claimed_until=NULL,claim_token=NULL,
        next_attempt_at=${retryAt}
        WHERE account_ref=${account} AND day=${scan.day}::date AND claim_token=${token}::uuid`.execute(
        this.db,
      );
      return { pending: true, imported: 0 };
    }
  }
}
