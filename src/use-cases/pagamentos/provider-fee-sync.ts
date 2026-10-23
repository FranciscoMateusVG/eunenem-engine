import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../adapters/database.js';
import type { ProcessingFeeReader } from '../../adapters/pagamentos/processing-fee-reader.js';

/** Sep/2026 launch in São Paulo. Never infer expense from the buyer surcharge. */
export const PROVIDER_FEES_SINCE = new Date('2026-09-01T00:00:00-03:00');
const ELIGIBLE = sql`p.intencao_metodo = 'credit_card' AND p.status IN ('aprovado','estornado')
  AND p.criado_em >= ${PROVIDER_FEES_SINCE}
  AND p.transacao_externa->>'provedor' = 'stripe'`;
interface Candidate {
  id: string;
  charge_ref: string | null;
  pi_ref: string | null;
}

export class ProviderFeeSync {
  constructor(
    private readonly db: Database,
    private readonly reader: ProcessingFeeReader | null,
    private readonly platformId: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async run(options: { dryRun?: boolean } = {}) {
    const now = this.clock();
    const eligible = sql`${ELIGIBLE} AND EXISTS (SELECT 1 FROM campanhas c
      WHERE c.id=p.intencao_id_campanha AND c.id_plataforma=${this.platformId}::uuid)`;
    const count = await sql<{
      n: string;
    }>`SELECT count(*) n FROM pagamentos p WHERE ${eligible}`.execute(this.db);
    const result = { eligible: Number(count.rows[0]?.n ?? 0), confirmed: 0, pending: 0 };
    if (options.dryRun || !this.reader) return result;
    // Bounded candidates and leases. No transaction/connection is held during network I/O.
    await sql`INSERT INTO provider_fee_sync(payment_id, next_attempt_at, updated_at)
      SELECT p.id, ${now}, ${now} FROM pagamentos p WHERE ${eligible}
      AND NOT EXISTS (SELECT 1 FROM provider_fee_sync s WHERE s.payment_id=p.id)
      ORDER BY p.criado_em, p.id LIMIT 20 ON CONFLICT DO NOTHING`.execute(this.db);
    const token = randomUUID();
    const candidates = await sql<Candidate>`WITH due AS (
      SELECT s.payment_id FROM provider_fee_sync s JOIN pagamentos p ON p.id=s.payment_id
      WHERE ${eligible} AND s.status='pending' AND s.next_attempt_at <= ${now}
      AND (s.claimed_until IS NULL OR s.claimed_until <= ${now})
      ORDER BY s.next_attempt_at, s.payment_id LIMIT 5 FOR UPDATE OF s SKIP LOCKED
    ), claimed AS (
      UPDATE provider_fee_sync s SET claimed_until=${new Date(now.getTime() + 180_000)},
        claim_token=${token}::uuid, attempts=attempts+1, updated_at=${now}
      FROM due WHERE s.payment_id=due.payment_id RETURNING s.payment_id
    ) SELECT p.id, p.intencao_charge_external_ref AS charge_ref,
      p.intencao_payment_intent_external_ref AS pi_ref
      FROM claimed c JOIN pagamentos p ON p.id=c.payment_id`.execute(this.db);
    for (const candidate of candidates.rows) {
      let reason = 'not_available';
      try {
        const fee = await this.reader.read({
          chargeRef: candidate.charge_ref,
          paymentIntentRef: candidate.pi_ref,
        });
        if (fee) {
          const confirmed = await this.db.transaction().execute(async (trx) => {
            const owned = await sql`SELECT payment_id FROM provider_fee_sync
              WHERE payment_id=${candidate.id}::uuid AND claim_token=${token}::uuid FOR UPDATE`.execute(
              trx,
            );
            if (!owned.rows.length) return false;
            const inserted = await sql`INSERT INTO provider_fee_events
              (provider,account_ref,environment,external_ref,payment_id,amount_cents,currency,occurred_at,observed_at,source)
              VALUES (${fee.provider},${fee.accountRef},${fee.environment},${fee.externalRef},${candidate.id}::uuid,
                ${fee.amountCents},${fee.currency},${fee.occurredAt},${now},${fee.source})
              ON CONFLICT(provider,account_ref,environment,external_ref) DO UPDATE
                SET observed_at=provider_fee_events.observed_at
                WHERE provider_fee_events.payment_id=EXCLUDED.payment_id
                  AND provider_fee_events.amount_cents=EXCLUDED.amount_cents
                  AND provider_fee_events.currency=EXCLUDED.currency
              RETURNING id`.execute(trx);
            if (!inserted.rows.length) throw new Error('fee_identity_conflict');
            await sql`UPDATE provider_fee_sync SET status='confirmed',last_reason=NULL,
              claimed_until=NULL,claim_token=NULL,updated_at=${now}
              WHERE payment_id=${candidate.id}::uuid AND claim_token=${token}::uuid`.execute(trx);
            return true;
          });
          if (confirmed) result.confirmed++;
          continue;
        }
      } catch {
        reason = 'provider_read_or_identity_error';
      }
      // No provider errors/bodies in logs; confirmation path is never touched.
      await sql`UPDATE provider_fee_sync SET last_reason=${reason},claimed_until=NULL,claim_token=NULL,
        next_attempt_at=${new Date(now.getTime() + 3_600_000)},updated_at=${now}
        WHERE payment_id=${candidate.id}::uuid AND claim_token=${token}::uuid`.execute(this.db);
      result.pending++;
    }
    return result;
  }
}
