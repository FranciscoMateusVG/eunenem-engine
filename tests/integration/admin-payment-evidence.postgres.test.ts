import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidPaymentEvidenceCursorError,
  listAdminPaymentEvidence,
  UNMATCHED_PAYMENT_EVIDENCE_LIMIT,
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
const OWNER_USER_ID = '11000000-0000-4000-8000-000000000001';
const OWNER_ACCOUNT_ID = '12000000-0000-4000-8000-000000000001';
const WEBHOOK_IDS = [
  '21000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002',
] as const;
const LIST_CONTEXT = {
  publicOrigin: 'https://staging.eunenem.com',
  cursorSecret: 'admin-payment-evidence-test-secret',
} as const;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
  await testDb.db
    .deleteFrom('payment_webhook_events')
    .where('ingress_platform_id', 'is not', null)
    .execute();
  await testDb.db
    .deleteFrom('payment_webhook_events')
    .where('id', 'in', [...WEBHOOK_IDS])
    .execute();
  await testDb.db
    .deleteFrom('pagamentos')
    .where('id', 'in', [...PAYMENT_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [CAMPAIGN_ID, OTHER_CAMPAIGN_ID])
    .execute();
  await testDb.db.deleteFrom('usuarios').where('id', '=', OWNER_USER_ID).execute();

  await testDb.db
    .insertInto('usuarios')
    .values({
      id: OWNER_USER_ID,
      id_plataforma: ID_PLATAFORMA_EUNENEM,
      id_conta: OWNER_ACCOUNT_ID,
      email: 'owner@example.test',
      nome_exibicao: 'Owner Teste',
      slug: 'owner-teste',
    })
    .execute();

  await testDb.db
    .insertInto('campanhas')
    .values([
      {
        id: CAMPAIGN_ID,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        titulo: 'Campanha EuNeném',
        slug: 'campanha-eunenem',
      },
      {
        id: OTHER_CAMPAIGN_ID,
        id_plataforma: randomUUID(),
        titulo: 'Campanha de outra plataforma',
        slug: 'campanha-externa',
      },
    ])
    .execute();
  await testDb.db
    .insertInto('campanha_administradores')
    .values({ campanha_id: CAMPAIGN_ID, id_usuario: OWNER_ACCOUNT_ID })
    .execute();
});

afterAll(async () => {
  await testDb.db
    .deleteFrom('payment_webhook_events')
    .where('id', 'in', [...WEBHOOK_IDS])
    .execute();
  await testDb.db
    .deleteFrom('pagamentos')
    .where('id', 'in', [...PAYMENT_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [CAMPAIGN_ID, OTHER_CAMPAIGN_ID])
    .execute();
  await testDb.db.deleteFrom('usuarios').where('id', '=', OWNER_USER_ID).execute();
  await testDb.teardown();
});

async function insertPayment(input: {
  id: (typeof PAYMENT_IDS)[number];
  campaignId?: string;
  method: 'pix' | 'credit_card';
  status: 'pendente' | 'aprovado';
  provider?: 'inter' | 'stripe';
  rawStatus?: string;
  contributorName?: string;
  contributorEmail?: string;
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
      intencao_contribuinte_nome,
      intencao_contribuinte_email,
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
      ${input.contributorName ?? `Pessoa ${input.id.slice(-1)}`},
      ${input.contributorEmail ?? `pessoa-${input.id.slice(-1)}@example.test`},
      ${input.provider === 'stripe' ? `cs_${input.id.slice(-1)}` : null},
      ${input.provider === 'stripe' ? `pi_${input.id.slice(-1)}` : null},
      ${input.provider === 'stripe' ? `ch_${input.id.slice(-1)}` : null},
      ${input.provider === 'inter' ? `E${'0'.repeat(30)}${input.id.slice(-1)}` : null},
      ${externalTransaction === null ? null : JSON.stringify(externalTransaction)}::jsonb
    )
  `.execute(testDb.db);
}

async function insertUnmatchedEvidence(input: {
  id?: string;
  provider: 'stripe' | 'inter';
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  ingressPlatformId?: string | null;
  signatureValid: boolean;
  receivedAt?: Date;
  processedAt?: Date | null;
  processingError?: string | null;
}): Promise<string> {
  const id = input.id ?? randomUUID();
  await testDb.db
    .insertInto('payment_webhook_events')
    .values({
      id,
      provider: input.provider,
      provider_event_id: input.providerEventId,
      event_type: input.eventType,
      raw_payload: input.rawPayload as never,
      signature_header: input.provider === 'stripe' ? 'synthetic-signature' : 'not-provided',
      signature_valid: input.signatureValid,
      ingress_platform_id: input.ingressPlatformId ?? null,
      received_at: input.receivedAt ?? CREATED_AT,
      processed_at: input.processedAt ?? null,
      processing_error: input.processingError ?? null,
      pagamento_id: null,
    })
    .execute();
  return id;
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
      ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      provider: null,
      status: null,
    });
    await expect(
      listAdminPaymentEvidence(testDb.db, {
        ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
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
      ...LIST_CONTEXT,
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

  it('combines payer and canonical campaign filters before rows and count', async () => {
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
      contributorName: 'Alice Percentual',
      contributorEmail: 'alice@example.test',
    });
    await insertPayment({
      id: PAYMENT_IDS[1],
      method: 'pix',
      status: 'pendente',
      contributorName: 'Bruno Literal',
      contributorEmail: 'bruno@example.test',
    });

    const result = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      payerQuery: 'Alice',
      campaignQuery: `${LIST_CONTEXT.publicOrigin}/pagina/owner-teste/campanha-eunenem`,
    });
    expect(result.totalCount).toBe(1);
    expect(result.rows.map((row) => row.paymentId)).toEqual([PAYMENT_IDS[0]]);
    expect(result.referenceResolution).toBe('not_requested');

    const wildcard = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      payerQuery: '%_',
    });
    expect(wildcard.totalCount).toBe(0);
  });

  it('resolves exact references by distinct tenant-scoped payment identity', async () => {
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });
    await insertPayment({
      id: PAYMENT_IDS[1],
      method: 'pix',
      status: 'pendente',
    });
    await insertPayment({
      id: PAYMENT_IDS[3],
      campaignId: OTHER_CAMPAIGN_ID,
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });
    const exactReference = 'reference-shared';
    await sql`
      UPDATE pagamentos
      SET intencao_external_ref = ${exactReference},
          intencao_payment_intent_external_ref = ${exactReference}
      WHERE id = ${PAYMENT_IDS[0]}::uuid
    `.execute(testDb.db);
    await sql`
      UPDATE pagamentos
      SET intencao_charge_external_ref = ${exactReference}
      WHERE id = ${PAYMENT_IDS[3]}::uuid
    `.execute(testDb.db);
    await testDb.db
      .insertInto('payment_webhook_events')
      .values({
        id: WEBHOOK_IDS[0],
        provider: 'stripe',
        provider_event_id: exactReference,
        event_type: 'checkout.session.completed',
        raw_payload: {},
        signature_header: 'synthetic-valid-signature',
        signature_valid: true,
        pagamento_id: PAYMENT_IDS[0],
      })
      .execute();

    const unique = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference,
    });
    expect(unique.referenceResolution).toBe('unique');
    expect(unique.rows.map((row) => row.paymentId)).toEqual([PAYMENT_IDS[0]]);

    await sql`
      UPDATE pagamentos
      SET transacao_externa = ${JSON.stringify({ id: exactReference })}::jsonb
      WHERE id = ${PAYMENT_IDS[1]}::uuid
    `.execute(testDb.db);
    const ambiguous = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference,
    });
    expect(ambiguous).toEqual({
      rows: [],
      nextCursor: null,
      totalCount: 0,
      referenceResolution: 'ambiguous',
      unmatchedEvidence: [],
      unmatchedEvidenceTruncated: false,
    });

    await testDb.db
      .insertInto('payment_webhook_events')
      .values({
        id: WEBHOOK_IDS[1],
        provider: 'stripe',
        provider_event_id: 'orphan-or-unknown-reference',
        event_type: 'checkout.session.completed',
        raw_payload: {},
        signature_header: 'synthetic-valid-signature',
        signature_valid: true,
        pagamento_id: null,
      })
      .execute();
    const absent = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: 'orphan-or-unknown-reference',
    });
    expect(absent.referenceResolution).toBe('absent');
    expect(absent.rows).toEqual([]);
    expect(absent.unmatchedEvidence).toEqual([]);
    expect(absent.unmatchedEvidenceTruncated).toBe(false);
  });

  it('returns future platform-scoped Stripe and unsigned Inter orphan receipts without raw data', async () => {
    const stripeReference = 'cs_future_receipt_1';
    const stripeId = await insertUnmatchedEvidence({
      provider: 'stripe',
      providerEventId: 'evt_future_receipt_1',
      eventType: 'checkout.session.completed',
      rawPayload: {
        data: {
          object: {
            id: stripeReference,
            customer_email: 'must-not-leak@example.test',
          },
        },
        privateCanary: 'raw-provider-body-must-not-leak',
      },
      ingressPlatformId: ID_PLATAFORMA_EUNENEM,
      signatureValid: true,
      processedAt: new Date('2026-09-08T14:01:00.000Z'),
    });
    const stripe = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: stripeReference,
    });
    expect(stripe.referenceResolution).toBe('unmatched');
    expect(stripe.rows).toEqual([]);
    expect(stripe.unmatchedEvidence).toEqual([
      {
        archiveId: stripeId,
        provider: 'stripe',
        matchedReferenceType: 'stripe_checkout_session',
        matchedReference: stripeReference,
        providerEventId: 'evt_future_receipt_1',
        eventType: 'checkout.session.completed',
        receivedAt: CREATED_AT.toISOString(),
        processedAt: '2026-09-08T14:01:00.000Z',
        trust: 'stripe_configured_secret_verified',
        processingState: 'processed',
        failureCategory: null,
        linkState: 'unmatched',
      },
    ]);
    expect(JSON.stringify(stripe)).not.toContain('must-not-leak');
    expect(JSON.stringify(stripe)).not.toContain('synthetic-signature');

    const interReference = 'T'.repeat(26);
    const interId = await insertUnmatchedEvidence({
      provider: 'inter',
      providerEventId: `${interReference}:${'E'.repeat(32)}`,
      eventType: 'pix.recebido',
      rawPayload: { txid: interReference, endToEndId: 'E'.repeat(32), cpf: 'must-not-leak' },
      ingressPlatformId: ID_PLATAFORMA_EUNENEM,
      signatureValid: false,
      processingError: 'charge_requery_failed',
    });
    const inter = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: interReference,
    });
    expect(inter.referenceResolution).toBe('unmatched');
    expect(inter.unmatchedEvidence).toEqual([
      expect.objectContaining({
        archiveId: interId,
        provider: 'inter',
        matchedReferenceType: 'inter_txid',
        trust: 'inter_unsigned_hint',
        processingState: 'failed',
        failureCategory: 'charge_requery_failed',
      }),
    ]);
    expect(JSON.stringify(inter)).not.toContain('must-not-leak');
  });

  it.each([
    {
      label: 'Stripe event id',
      provider: 'stripe' as const,
      providerEventId: 'evt_exactevent1',
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: 'ch_unrelated_1' } } },
      exactReference: 'evt_exactevent1',
      matchedReferenceType: 'provider_event_id',
      signatureValid: true,
    },
    {
      label: 'Stripe charge id',
      provider: 'stripe' as const,
      providerEventId: 'evt_exact_charge_1',
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: 'ch_exact_charge_1' } } },
      exactReference: 'ch_exact_charge_1',
      matchedReferenceType: 'stripe_charge',
      signatureValid: true,
    },
    {
      label: 'Inter composite event id',
      provider: 'inter' as const,
      providerEventId: `${'I'.repeat(26)}:${'J'.repeat(32)}`,
      eventType: 'pix.recebido',
      rawPayload: { txid: 'I'.repeat(26), endToEndId: 'J'.repeat(32) },
      exactReference: `${'I'.repeat(26)}:${'J'.repeat(32)}`,
      matchedReferenceType: 'provider_event_id',
      signatureValid: false,
    },
    {
      label: 'Inter end-to-end id',
      provider: 'inter' as const,
      providerEventId: `${'K'.repeat(26)}:${'L'.repeat(32)}`,
      eventType: 'pix.recebido',
      rawPayload: { txid: 'K'.repeat(26), endToEndId: 'L'.repeat(32) },
      exactReference: 'L'.repeat(32),
      matchedReferenceType: 'inter_e2e',
      signatureValid: false,
    },
  ])('matches the strict $label tuple without generic JSON traversal', async (fixture) => {
    await insertUnmatchedEvidence({
      ...fixture,
      ingressPlatformId: ID_PLATAFORMA_EUNENEM,
    });
    const result = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: fixture.exactReference,
    });
    expect(result.referenceResolution).toBe('unmatched');
    expect(result.unmatchedEvidence).toHaveLength(1);
    expect(result.unmatchedEvidence[0]).toMatchObject({
      provider: fixture.provider,
      matchedReferenceType: fixture.matchedReferenceType,
      matchedReference: fixture.exactReference,
    });
  });

  it('keeps linked, unmatched, mixed and ambiguous resolution explicit without choosing a payment', async () => {
    const reference = 'pi_mixed_reference';
    await insertPayment({
      id: PAYMENT_IDS[0],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });
    await sql`
      UPDATE pagamentos
      SET intencao_payment_intent_external_ref = ${reference}
      WHERE id = ${PAYMENT_IDS[0]}::uuid
    `.execute(testDb.db);
    const orphanId = await insertUnmatchedEvidence({
      provider: 'stripe',
      providerEventId: 'evt_mixed_reference',
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: reference } } },
      ingressPlatformId: ID_PLATAFORMA_EUNENEM,
      signatureValid: true,
    });

    const mixed = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: reference,
    });
    expect(mixed.referenceResolution).toBe('mixed');
    expect(mixed.rows.map((row) => row.paymentId)).toEqual([PAYMENT_IDS[0]]);
    expect(mixed.unmatchedEvidence.map((row) => row.archiveId)).toEqual([orphanId]);

    await insertPayment({
      id: PAYMENT_IDS[1],
      method: 'credit_card',
      status: 'aprovado',
      provider: 'stripe',
    });
    await sql`
      UPDATE pagamentos
      SET intencao_external_ref = ${reference}
      WHERE id = ${PAYMENT_IDS[1]}::uuid
    `.execute(testDb.db);
    const ambiguous = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: reference,
    });
    expect(ambiguous.referenceResolution).toBe('ambiguous');
    expect(ambiguous.rows).toEqual([]);
    expect(ambiguous.unmatchedEvidence.map((row) => row.archiveId)).toEqual([orphanId]);
  });

  it('excludes unscoped, cross-platform, invalid Stripe and non-allowlisted tuple evidence', async () => {
    const reference = 'pi_denied_reference';
    const otherPlatformId = randomUUID();
    const seeds = [
      {
        providerEventId: 'evt_unscoped_reference',
        ingressPlatformId: null,
        signatureValid: true,
        eventType: 'payment_intent.succeeded',
      },
      {
        providerEventId: 'evt_cross_platform_reference',
        ingressPlatformId: otherPlatformId,
        signatureValid: true,
        eventType: 'payment_intent.succeeded',
      },
      {
        providerEventId: 'evt_invalid_signature_reference',
        ingressPlatformId: ID_PLATAFORMA_EUNENEM,
        signatureValid: false,
        eventType: 'payment_intent.succeeded',
      },
      {
        providerEventId: 'evt_wrong_tuple_reference',
        ingressPlatformId: ID_PLATAFORMA_EUNENEM,
        signatureValid: true,
        eventType: 'invoice.created',
      },
    ] as const;
    for (const seed of seeds) {
      await insertUnmatchedEvidence({
        provider: 'stripe',
        rawPayload: { data: { object: { id: reference } } },
        ...seed,
      });
    }
    await insertUnmatchedEvidence({
      provider: 'stripe',
      providerEventId: 'evt_inconsistent_state_reference',
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: reference } } },
      ingressPlatformId: ID_PLATAFORMA_EUNENEM,
      signatureValid: true,
      processedAt: new Date('2026-09-08T14:03:00.000Z'),
      processingError: 'dispatch_failed',
    });

    const result = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: reference,
    });
    expect(result.referenceResolution).toBe('absent');
    expect(result.unmatchedEvidence).toEqual([]);
  });

  it('caps unmatched evidence deterministically and sanitizes unknown failure text', async () => {
    const reference = 'pi_capped_reference';
    const ids: string[] = [];
    for (let index = 0; index <= UNMATCHED_PAYMENT_EVIDENCE_LIMIT; index += 1) {
      const id = await insertUnmatchedEvidence({
        provider: 'stripe',
        providerEventId: `evt_cap_${String(index).padStart(2, '0')}`,
        eventType: 'payment_intent.payment_failed',
        rawPayload: { data: { object: { id: reference } } },
        ingressPlatformId: ID_PLATAFORMA_EUNENEM,
        signatureValid: true,
        receivedAt: new Date(CREATED_AT.getTime() + index * 1_000),
        processingError:
          index === UNMATCHED_PAYMENT_EVIDENCE_LIMIT
            ? 'provider-secret-text-must-not-leak'
            : 'dispatch_failed',
      });
      ids.push(id);
    }

    const result = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 10,
      provider: null,
      status: null,
      exactReference: reference,
    });
    expect(result.referenceResolution).toBe('unmatched');
    expect(result.unmatchedEvidence).toHaveLength(UNMATCHED_PAYMENT_EVIDENCE_LIMIT);
    expect(result.unmatchedEvidenceTruncated).toBe(true);
    expect(result.unmatchedEvidence[0]).toMatchObject({
      archiveId: ids.at(-1),
      failureCategory: null,
    });
    expect(result.unmatchedEvidence.at(-1)?.archiveId).toBe(ids[1]);
    expect(JSON.stringify(result)).not.toContain('provider-secret-text');
  });

  it('binds cursors to payer and campaign filters without exposing raw values', async () => {
    await insertPayment({ id: PAYMENT_IDS[0], method: 'pix', status: 'pendente' });
    await insertPayment({ id: PAYMENT_IDS[1], method: 'pix', status: 'pendente' });
    const first = await listAdminPaymentEvidence(testDb.db, {
      ...LIST_CONTEXT,
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      provider: null,
      status: null,
      campaignQuery: 'Campanha',
    });
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain('Campanha');

    await expect(
      listAdminPaymentEvidence(testDb.db, {
        ...LIST_CONTEXT,
        platformId: ID_PLATAFORMA_EUNENEM,
        cursor: first.nextCursor,
        limit: 1,
        provider: null,
        status: null,
        campaignQuery: 'Outra campanha',
      }),
    ).rejects.toBeInstanceOf(InvalidPaymentEvidenceCursorError);
  });
});
