import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidPaymentEvidenceCursorError,
  listAdminPaymentEvidence,
} from '../../apps/eunenem-server/server/admin-payment-evidence.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const CAMPAIGN_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_CAMPAIGN_ID = '10000000-0000-4000-8000-000000000002';
const PAYMENT_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
] as const;
const CREATED_AT = new Date('2026-09-08T14:00:00.000Z');

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
  await testDb.db
    .deleteFrom('pagamentos')
    .where('id', 'in', [...PAYMENT_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [CAMPAIGN_ID, OTHER_CAMPAIGN_ID])
    .execute();

  await testDb.db
    .insertInto('campanhas')
    .values([
      {
        id: CAMPAIGN_ID,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        titulo: 'Campanha EuNeném',
      },
      {
        id: OTHER_CAMPAIGN_ID,
        id_plataforma: randomUUID(),
        titulo: 'Campanha de outra plataforma',
      },
    ])
    .execute();
});

afterAll(async () => {
  await testDb.db
    .deleteFrom('pagamentos')
    .where('id', 'in', [...PAYMENT_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [CAMPAIGN_ID, OTHER_CAMPAIGN_ID])
    .execute();
  await testDb.teardown();
});

async function insertPayment(input: {
  id: (typeof PAYMENT_IDS)[number];
  campaignId?: string;
  method: 'pix' | 'credit_card';
  status: 'pendente' | 'aprovado';
  provider?: 'inter' | 'stripe';
  rawStatus?: string;
}): Promise<void> {
  const externalTransaction = input.provider
    ? {
        id: `external-${input.id.slice(-1)}`,
        provedor: input.provider,
        status: 'aprovado',
        amountCents: 2_000,
        criadaEm: CREATED_AT.toISOString(),
        statusBruto: input.rawStatus ?? 'paid',
      }
    : null;

  await sql`
    INSERT INTO pagamentos (
      id,
      status,
      criado_em,
      atualizado_em,
      intencao_id,
      intencao_id_campanha,
      intencao_metodo,
      intencao_criada_em,
      intencao_total_contribution_cents,
      intencao_total_fee_cents,
      intencao_total_receiver_cents,
      intencao_total_surcharge_cents,
      intencao_total_paid_cents,
      intencao_external_ref,
      intencao_payment_intent_external_ref,
      intencao_charge_external_ref,
      intencao_e2e_external_ref,
      transacao_externa
    ) VALUES (
      ${input.id}::uuid,
      ${input.status},
      ${CREATED_AT},
      ${CREATED_AT},
      ${randomUUID()}::uuid,
      ${input.campaignId ?? CAMPAIGN_ID}::uuid,
      ${input.method},
      ${CREATED_AT},
      1_800,
      100,
      1_700,
      100,
      2_000,
      ${input.provider === 'stripe' ? `cs_${input.id.slice(-1)}` : null},
      ${input.provider === 'stripe' ? `pi_${input.id.slice(-1)}` : null},
      ${input.provider === 'stripe' ? `ch_${input.id.slice(-1)}` : null},
      ${input.provider === 'inter' ? `E${'0'.repeat(30)}${input.id.slice(-1)}` : null},
      ${externalTransaction === null ? null : JSON.stringify(externalTransaction)}::jsonb
    )
  `.execute(testDb.db);
}

describe('listAdminPaymentEvidence — Postgres', () => {
  it('applies platform scope before deterministic cursor pagination and totalCount', async () => {
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
      rawStatus: 'succeeded',
    });
    await insertPayment({
      id: PAYMENT_IDS[1],
      method: 'pix',
      status: 'aprovado',
      provider: 'inter',
      rawStatus: 'CONCLUIDA',
    });
    await insertPayment({ id: PAYMENT_IDS[2], method: 'pix', status: 'pendente' });
    await insertPayment({
      id: PAYMENT_IDS[3],
      campaignId: OTHER_CAMPAIGN_ID,
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });

    const first = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 2,
      provider: null,
      status: null,
    });
    expect(first.totalCount).toBe(3);
    expect(first.rows.map((row) => row.paymentId)).toEqual([PAYMENT_IDS[2], PAYMENT_IDS[1]]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: first.nextCursor,
      limit: 2,
      provider: null,
      status: null,
    });
    expect(second.totalCount).toBe(3);
    expect(second.rows.map((row) => row.paymentId)).toEqual([PAYMENT_IDS[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('binds cursors to filters and projects only bounded stored evidence', async () => {
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
      rawStatus: 'succeeded',
    });
    await insertPayment({
      id: PAYMENT_IDS[1],
      method: 'pix',
      status: 'aprovado',
      provider: 'inter',
      rawStatus: 'CONCLUIDA',
    });

    const stripe = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      provider: 'stripe',
      status: 'aprovado',
    });
    expect(stripe.totalCount).toBe(1);
    expect(stripe.rows).toHaveLength(1);
    expect(stripe.rows[0]?.providerEvidence).toEqual({
      provider: 'stripe',
      normalizedStatus: 'aprovado',
      rawStatus: 'succeeded',
      providerAmountCents: 2_000,
      providerRecordedAt: CREATED_AT.toISOString(),
      checkoutSessionRef: 'cs_1',
      paymentIntentRef: 'pi_1',
      chargeRef: 'ch_1',
      interE2eRef: null,
      externalTransactionRef: 'external-1',
    });
    expect(Object.keys(stripe.rows[0] ?? {})).not.toContain('contributor');
    expect(Object.keys(stripe.rows[0] ?? {})).not.toContain('rawPayload');

    const unfiltered = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      provider: null,
      status: null,
    });
    await expect(
      listAdminPaymentEvidence(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        cursor: unfiltered.nextCursor,
        limit: 1,
        provider: 'inter',
        status: null,
      }),
    ).rejects.toBeInstanceOf(InvalidPaymentEvidenceCursorError);
  });

  it('represents absent provider evidence explicitly instead of fabricating it', async () => {
    await insertPayment({ id: PAYMENT_IDS[2], method: 'pix', status: 'pendente' });

    const result = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: 'pendente',
    });
    expect(result.totalCount).toBe(1);
    expect(result.rows[0]?.providerEvidence).toEqual({
      provider: null,
      normalizedStatus: null,
      rawStatus: null,
      providerAmountCents: null,
      providerRecordedAt: null,
      checkoutSessionRef: null,
      paymentIntentRef: null,
      chargeRef: null,
      interE2eRef: null,
      externalTransactionRef: null,
    });
  });

  it('drops unknown, control-bearing, and oversized evidence at the read boundary', async () => {
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });
    await sql`
      UPDATE pagamentos
      SET
        intencao_external_ref = ${'x'.repeat(256)},
        intencao_payment_intent_external_ref = ${'pi\nunsafe'},
        transacao_externa = ${JSON.stringify({
          id: 'external\u001bunsafe',
          provedor: 'unknown-provider',
          status: 'unknown-status',
          statusBruto: 'paid\runsafe',
          amountCents: -1,
          criadaEm: 'not-a-date',
        })}::jsonb
      WHERE id = ${PAYMENT_IDS[0]}::uuid
    `.execute(testDb.db);

    const result = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
    });

    expect(result.rows[0]?.providerEvidence).toEqual({
      provider: null,
      normalizedStatus: null,
      rawStatus: null,
      providerAmountCents: null,
      providerRecordedAt: null,
      checkoutSessionRef: null,
      paymentIntentRef: null,
      chargeRef: 'ch_1',
      interE2eRef: null,
      externalTransactionRef: null,
    });
  });

  it('isolates an unsafe campaign title instead of failing the whole page', async () => {
    await testDb.db
      .updateTable('campanhas')
      .set({ titulo: 'Título\nperigoso' })
      .where('id', '=', CAMPAIGN_ID)
      .execute();
    await testDb.db
      .updateTable('campanhas')
      .set({ id_plataforma: ID_PLATAFORMA_EUNENEM, titulo: 'Título normal' })
      .where('id', '=', OTHER_CAMPAIGN_ID)
      .execute();
    await insertPayment({ id: PAYMENT_IDS[0], method: 'pix', status: 'pendente' });
    await insertPayment({
      id: PAYMENT_IDS[1],
      campaignId: OTHER_CAMPAIGN_ID,
      method: 'pix',
      status: 'pendente',
    });

    const result = await listAdminPaymentEvidence(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
    });

    expect(result.totalCount).toBe(2);
    expect(result.rows.map((row) => row.campaignTitle).sort()).toEqual([
      'Título indisponível',
      'Título normal',
    ]);
    expect(JSON.stringify(result)).not.toContain('Título\\nperigoso');
  });
});
