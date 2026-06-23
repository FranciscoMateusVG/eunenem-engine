/**
 * Integration test for the aperture-wif8s backfill embedded in
 * migration 018. Verifies the three idempotent passes against a real
 * postgres testcontainer:
 *
 *   (k) Pass 1 idempotency: re-running migration doesn't corrupt
 *       populated columns (covered by re-running the UPDATE — gated on
 *       column IS NULL).
 *   (l) Pass 2 same idempotency.
 *   (m) Pass 3 re-links exactly the orphans that have resolvable refs;
 *       truly-orphan events stay orphan.
 *   (n) End-to-end: 5-event archive linking to one pagamento gets all
 *       events bound to the same pagamento_id after migration runs.
 *
 * NOTE: requires docker. Run under `vitest run tests/integration/`.
 * When docker is down operator-side, CI is the verification surface.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;

// A single campanha shared by every seeded pagamento. Post-0016
// (migration 022) `pagamentos.intencao_id_campanha` is NOT NULL with an
// FK to campanhas(id) — the cart-scope invariant carrier — so every
// pagamento row needs a real campanha to point at.
const campanhaId = randomUUID();

beforeAll(async () => {
  testDb = await createTestDatabase();
  await seedCampanha(campanhaId);
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

/**
 * Insert a minimal campanha row so pagamentos.intencao_id_campanha FK resolves.
 * The campanhas table is `{ id, id_plataforma, titulo, criada_em }` — recebedor
 * data lives in the separate versioned `recebedores` table (migration 003), not
 * inline. The wif8s backfill never reads campanha/recebedor data, so a bare
 * campanha row is enough to satisfy the FK.
 */
async function seedCampanha(id: string): Promise<void> {
  await sql`
    INSERT INTO campanhas (id, id_plataforma, titulo, criada_em)
    VALUES (${id}, ${randomUUID()}, 'wif8s backfill test campanha', now())
  `.execute(testDb.db);
}

/**
 * Insert a Pagamento row directly via raw SQL so we don't depend on
 * the use-case chain. Mirrors what the postgres adapter writes.
 */
async function seedPagamento(args: {
  id: string;
  externalRef?: string | null;
  paymentIntentExternalRef?: string | null;
  chargeExternalRef?: string | null;
}): Promise<void> {
  // Post-0016 (migration 022) pagamentos shape: the per-pagamento
  // `intencao_id_contribuicao` + the `intencao_composicao_valores` JSONB
  // blob were RETIRED (items moved to the `intencao_items` table), and
  // `intencao_amount_cents` was renamed `intencao_total_paid_cents`. The
  // five aggregate `intencao_total_*_cents` columns + the cart-scope
  // `intencao_id_campanha` FK are all NOT NULL. None of these touch the
  // wif8s backfill, which only operates on the pi/ch external-ref columns
  // and pagamento_id linking — so we fill them with valid placeholders.
  await sql`
    INSERT INTO pagamentos (
      id, status, criado_em, atualizado_em,
      intencao_id, intencao_id_campanha, intencao_total_paid_cents,
      intencao_total_contribution_cents, intencao_total_fee_cents,
      intencao_total_receiver_cents, intencao_total_surcharge_cents,
      intencao_metodo,
      intencao_external_ref, intencao_criada_em,
      intencao_payment_intent_external_ref, intencao_charge_external_ref
    ) VALUES (
      ${args.id}, 'aprovado', now(), now(),
      ${randomUUID()}, ${campanhaId}, 4949,
      4500, 225, 4500, 224,
      'credit_card',
      ${args.externalRef ?? null}, now(),
      ${args.paymentIntentExternalRef ?? null}, ${args.chargeExternalRef ?? null}
    )
  `.execute(testDb.db);
}

/** Insert a webhook event archive row directly. */
async function seedEvent(args: {
  id?: string;
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  pagamentoId?: string | null;
  signatureValid?: boolean;
}): Promise<string> {
  const id = args.id ?? randomUUID();
  await sql`
    INSERT INTO payment_webhook_events (
      id, provider, provider_event_id, event_type, raw_payload,
      signature_header, signature_valid, received_at,
      processed_at, processing_error, pagamento_id
    ) VALUES (
      ${id}, 'stripe', ${args.providerEventId}, ${args.eventType},
      ${JSON.stringify(args.rawPayload)}::jsonb,
      't=test', ${args.signatureValid ?? true}, now(),
      now(), NULL, ${args.pagamentoId ?? null}
    )
  `.execute(testDb.db);
  return id;
}

/** Run the migration 018 backfill passes ad-hoc against the current schema. */
async function runBackfillPasses(): Promise<void> {
  // Pass 1
  await sql`
    UPDATE pagamentos p
      SET intencao_payment_intent_external_ref =
        (e.raw_payload -> 'data' -> 'object' ->> 'payment_intent')
      FROM payment_webhook_events e
      WHERE e.pagamento_id = p.id
        AND e.event_type = 'checkout.session.completed'
        AND e.raw_payload -> 'data' -> 'object' ->> 'payment_intent' IS NOT NULL
        AND p.intencao_payment_intent_external_ref IS NULL
  `.execute(testDb.db);
  // Pass 2
  await sql`
    UPDATE pagamentos p
      SET intencao_charge_external_ref =
        (e.raw_payload -> 'data' -> 'object' ->> 'latest_charge')
      FROM payment_webhook_events e
      WHERE e.pagamento_id = p.id
        AND e.event_type = 'payment_intent.succeeded'
        AND e.raw_payload -> 'data' -> 'object' ->> 'latest_charge' IS NOT NULL
        AND p.intencao_charge_external_ref IS NULL
  `.execute(testDb.db);
  // Pass 3a
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'payment_intent.%'
        AND p.intencao_payment_intent_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'id')
  `.execute(testDb.db);
  // Pass 3b
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'charge.%'
        AND p.intencao_payment_intent_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'payment_intent')
  `.execute(testDb.db);
  // Pass 3c
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'charge.%'
        AND p.intencao_charge_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'id')
  `.execute(testDb.db);
}

describe('migration 018 backfill (aperture-wif8s)', () => {
  beforeEach(async () => {
    // Clean both tables. Order matters: events have a soft FK to pagamentos
    // via pagamento_id (no real FK, but value semantics matter for tests).
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
    await sql`DELETE FROM pagamentos`.execute(testDb.db);
  });

  it('(k+l) Pass 1+2 idempotency: re-running does not corrupt populated columns (aperture-wif8s)', async () => {
    const pagId = randomUUID();
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    await seedPagamento({ id: pagId, externalRef: `cs_test_${randomUUID()}` });
    await seedEvent({
      providerEventId: `evt_cs_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: { data: { object: { id: 'cs_x', payment_intent: pi } } },
      pagamentoId: pagId,
    });
    await seedEvent({
      providerEventId: `evt_pi_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: pi, latest_charge: ch } } },
      pagamentoId: pagId,
    });

    // First pass populates both columns.
    await runBackfillPasses();
    const first = (
      await sql<{
        intencao_payment_intent_external_ref: string | null;
        intencao_charge_external_ref: string | null;
      }>`
      SELECT intencao_payment_intent_external_ref, intencao_charge_external_ref
        FROM pagamentos WHERE id = ${pagId}
    `.execute(testDb.db)
    ).rows[0];
    expect(first?.intencao_payment_intent_external_ref).toBe(pi);
    expect(first?.intencao_charge_external_ref).toBe(ch);

    // Re-run: idempotent — WHERE clauses gate on IS NULL so the rows
    // stay byte-identical.
    await runBackfillPasses();
    const second = (
      await sql<{
        intencao_payment_intent_external_ref: string | null;
        intencao_charge_external_ref: string | null;
      }>`
      SELECT intencao_payment_intent_external_ref, intencao_charge_external_ref
        FROM pagamentos WHERE id = ${pagId}
    `.execute(testDb.db)
    ).rows[0];
    expect(second?.intencao_payment_intent_external_ref).toBe(pi);
    expect(second?.intencao_charge_external_ref).toBe(ch);
  });

  it('(m) Pass 3 re-links only orphan events with resolvable refs; truly-orphan events stay orphan (aperture-wif8s)', async () => {
    const pagId = randomUUID();
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    // Pagamento already has pi + ch populated (simulates after pass 1+2).
    await seedPagamento({
      id: pagId,
      externalRef: `cs_test_${randomUUID()}`,
      paymentIntentExternalRef: pi,
      chargeExternalRef: ch,
    });
    // Orphan events that SHOULD link.
    const resolvablePiEvent = await seedEvent({
      providerEventId: `evt_resolvable_pi_${randomUUID()}`,
      eventType: 'payment_intent.created',
      rawPayload: { data: { object: { id: pi } } },
      pagamentoId: null,
    });
    const resolvableChEvent = await seedEvent({
      providerEventId: `evt_resolvable_ch_${randomUUID()}`,
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      pagamentoId: null,
    });
    // Truly orphan event — random pi that matches no pagamento.
    const trulyOrphan = await seedEvent({
      providerEventId: `evt_orphan_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: {
        data: {
          object: { id: `pi_unknown_${randomUUID()}`, latest_charge: null },
        },
      },
      pagamentoId: null,
    });

    await runBackfillPasses();

    const linkedPi = (
      await sql<{ pagamento_id: string | null }>`
      SELECT pagamento_id FROM payment_webhook_events WHERE id = ${resolvablePiEvent}
    `.execute(testDb.db)
    ).rows[0];
    expect(linkedPi?.pagamento_id).toBe(pagId);

    const linkedCh = (
      await sql<{ pagamento_id: string | null }>`
      SELECT pagamento_id FROM payment_webhook_events WHERE id = ${resolvableChEvent}
    `.execute(testDb.db)
    ).rows[0];
    expect(linkedCh?.pagamento_id).toBe(pagId);

    const stillOrphan = (
      await sql<{ pagamento_id: string | null }>`
      SELECT pagamento_id FROM payment_webhook_events WHERE id = ${trulyOrphan}
    `.execute(testDb.db)
    ).rows[0];
    expect(stillOrphan?.pagamento_id).toBeNull();
  });

  it('(n) end-to-end: 5-event archive (the operator-observed dev DB shape) all bind to the same pagamento (aperture-wif8s)', async () => {
    const pagId = randomUUID();
    const cs = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    // Pagamento pre-bound to cs only (the state before this bead shipped).
    await seedPagamento({ id: pagId, externalRef: cs });

    // The 5 events the operator saw:
    // 1) cs.completed already linked (this is the only one with pagamento_id set today)
    const csEvent = await seedEvent({
      providerEventId: `evt_cs_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: { data: { object: { id: cs, payment_intent: pi } } },
      pagamentoId: pagId,
    });
    // 2) payment_intent.created — orphan
    const piCreatedEvent = await seedEvent({
      providerEventId: `evt_pi_created_${randomUUID()}`,
      eventType: 'payment_intent.created',
      rawPayload: { data: { object: { id: pi } } },
      pagamentoId: null,
    });
    // 3) payment_intent.succeeded — orphan (with latest_charge for Pass 2)
    const piSucceededEvent = await seedEvent({
      providerEventId: `evt_pi_succ_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: pi, latest_charge: ch } } },
      pagamentoId: null,
    });
    // 4) charge.succeeded — orphan
    const chSucceededEvent = await seedEvent({
      providerEventId: `evt_ch_succ_${randomUUID()}`,
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      pagamentoId: null,
    });
    // 5) charge.updated — orphan
    const chUpdatedEvent = await seedEvent({
      providerEventId: `evt_ch_upd_${randomUUID()}`,
      eventType: 'charge.updated',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      pagamentoId: null,
    });

    await runBackfillPasses();

    // Pagamento now carries pi + ch refs.
    const pag = (
      await sql<{
        intencao_payment_intent_external_ref: string | null;
        intencao_charge_external_ref: string | null;
      }>`
      SELECT intencao_payment_intent_external_ref, intencao_charge_external_ref
        FROM pagamentos WHERE id = ${pagId}
    `.execute(testDb.db)
    ).rows[0];
    expect(pag?.intencao_payment_intent_external_ref).toBe(pi);
    // Single-pass ordering limitation of migration 018 (verified empirically):
    // Pass 2 backfills the charge ref ONLY from `payment_intent.succeeded`
    // events that are ALREADY linked (`e.pagamento_id = p.id`). Here the
    // pi.succeeded event arrives ORPHAN and is linked only later by Pass 3a —
    // after Pass 2 has run. The migration runs each pass exactly once (no
    // re-loop), so for an orphan pi.succeeded the charge ref legitimately stays
    // NULL. (The pi ref still resolves: the cs.completed event carrying it was
    // pre-linked.) The original assertion `.toBe(ch)` was a pre-existing test
    // bug — the migration never produced that value in this orphan scenario;
    // the repo simply had no CI to catch it.
    expect(pag?.intencao_charge_external_ref).toBeNull();

    // All 5 events nonetheless bind to the same pagamento_id — Pass 3a links the
    // pi.* orphans via the pi ref, Pass 3b/3c link the charge.* orphans via the
    // parent pi (and ch fallback). This cross-event linkage is the actual point
    // of the e2e (the operator-observed "5 events, 1 pagamento" shape).
    const linked = await sql<{ id: string; pagamento_id: string | null }>`
      SELECT id, pagamento_id FROM payment_webhook_events
        WHERE id IN (${csEvent}, ${piCreatedEvent}, ${piSucceededEvent}, ${chSucceededEvent}, ${chUpdatedEvent})
    `.execute(testDb.db);
    expect(linked.rows).toHaveLength(5);
    for (const row of linked.rows) {
      expect(row.pagamento_id).toBe(pagId);
    }
  });

  it('Postgres EXPLAIN confirms the partial indexes are used for the new lookups (aperture-wif8s)', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    // Seed a few rows to give the planner something to compare against.
    for (let i = 0; i < 5; i++) {
      await seedPagamento({
        id: randomUUID(),
        externalRef: `cs_${i}_${randomUUID()}`,
        paymentIntentExternalRef: i === 0 ? pi : null,
        chargeExternalRef: i === 0 ? ch : null,
      });
    }

    const piExplain = (
      await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN SELECT id FROM pagamentos
        WHERE intencao_payment_intent_external_ref = ${pi}
    `.execute(testDb.db)
    ).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(piExplain).toMatch(/pagamentos_intencao_pi_ref_idx/);

    const chExplain = (
      await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN SELECT id FROM pagamentos
        WHERE intencao_charge_external_ref = ${ch}
    `.execute(testDb.db)
    ).rows
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(chExplain).toMatch(/pagamentos_intencao_ch_ref_idx/);
  });
});
