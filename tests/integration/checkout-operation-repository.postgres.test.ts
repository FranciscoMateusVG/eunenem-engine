import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckoutOperationSnapshot } from '../../src/adapters/pagamentos/checkout-operation-repository.js';
import { CheckoutOperationRepositoryPostgres } from '../../src/adapters/pagamentos/checkout-operation-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import type { Pagamento } from '../../src/domain/pagamentos/entities/pagamento.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  // The Vitest harness shares one PostgreSQL container across files. Remove
  // this suite's durable audit children before unrelated legacy fixtures
  // clear pagamentos with their historical child-first helpers.
  await sql`
    TRUNCATE payment_provider_operation_attempt_facts,
             payment_provider_operations
  `.execute(testDb.db);
  await testDb.teardown();
});

beforeEach(async () => {
  await sql`
    TRUNCATE payment_provider_operation_attempt_facts,
             payment_provider_operations,
             pagamentos,
             intencao_items,
             contribuicoes,
             opcoes_contribuicao,
             campanhas
    CASCADE
  `.execute(testDb.db);
});

function buildFixture(): {
  pagamento: Pagamento;
  snapshot: CheckoutOperationSnapshot;
  platformId: string;
} {
  const pagamento = makePagamento({ id: randomUUID() });
  const platformId = randomUUID();
  const contribution = pagamento.intencao.items.find((item) => item.tipo === 'contribuicao');
  if (!contribution || contribution.tipo !== 'contribuicao') throw new Error('fixture item');
  return {
    pagamento,
    platformId,
    snapshot: {
      operationId: pagamento.id,
      platformId,
      campaignId: pagamento.intencao.idCampanha,
      paymentId: pagamento.id,
      intentId: pagamento.intencao.id,
      method: pagamento.intencao.metodo,
      provider: 'stripe',
      items: pagamento.intencao.items.map((item) =>
        item.tipo === 'contribuicao'
          ? {
              paymentItemId: item.id,
              contributionId: item.idContribuicao,
              optionId: randomUUID(),
              optionType: 'presente',
              quantity: item.composicaoValoresItem.quantidade,
              contributionCents: item.composicaoValoresItem.lineContributionAmountCents,
              feeCents: item.composicaoValoresItem.lineFeeAmountCents,
              receiverCents: item.composicaoValoresItem.lineReceiverAmountCents,
              surchargeCents: 0,
            }
          : {
              paymentItemId: item.id,
              contributionId: null,
              optionId: null,
              optionType: null,
              quantity: 1,
              contributionCents: 0,
              feeCents: 0,
              receiverCents: 0,
              surchargeCents: item.composicaoValoresItem.amountCents,
            },
      ),
      totalChargedCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      totalReceiverCents: pagamento.intencao.composicaoValoresAggregate.totalReceiverCents,
      totalSurchargeCents: pagamento.intencao.composicaoValoresAggregate.totalSurchargeCents,
      idempotencyKey: `pagamento:${pagamento.id}:create-session`,
      anchorContributionId: contribution.idContribuicao,
      anchorOptionId: randomUUID(),
      anchorOptionType: 'presente',
      redirectOnCompletion: 'if_required',
    },
  };
}

const capabilityHash = 'a'.repeat(64);
const requestHmac = 'b'.repeat(64);

describe('CheckoutOperationRepositoryPostgres', () => {
  it('persists the payment reservation and a claim fact before provider I/O', async () => {
    const { pagamento, snapshot, platformId } = buildFixture();
    await seedPagamentoParents(testDb.db, pagamento);
    const repo = new CheckoutOperationRepositoryPostgres(testDb.db);
    const now = new Date('2026-09-09T12:00:00Z');

    const prepared = await repo.prepare({
      pagamento,
      operationId: pagamento.id,
      platformId,
      campaignId: pagamento.intencao.idCampanha,
      provider: 'stripe',
      method: pagamento.intencao.metodo,
      capabilityHash,
      requestHmac,
      snapshot,
      now,
    });
    expect(prepared.created).toBe(true);
    await expect(
      new PagamentoRepositoryPostgres(testDb.db).findById(pagamento.id),
    ).resolves.toBeDefined();

    const claim = await repo.claim({
      operationId: pagamento.id,
      capabilityHash,
      requestHmac,
      now,
      leaseUntil: new Date(now.getTime() + 30_000),
    });
    expect(claim).toMatchObject({ status: 'claimed', claimKind: 'create', attemptNo: 1 });
    const facts = await sql<{ fact_kind: string; outcome: string | null }>`
      SELECT fact_kind, outcome
      FROM payment_provider_operation_attempt_facts
      WHERE operation_id = ${pagamento.id}::uuid
      ORDER BY attempt_no, fact_kind
    `.execute(testDb.db);
    expect(facts.rows).toEqual([{ fact_kind: 'claim', outcome: null }]);
  });

  it('fences a crashed worker and commits only the current provider result', async () => {
    const { pagamento, snapshot, platformId } = buildFixture();
    await seedPagamentoParents(testDb.db, pagamento);
    const repo = new CheckoutOperationRepositoryPostgres(testDb.db);
    const t0 = new Date('2026-09-09T12:00:00Z');
    await repo.prepare({
      pagamento,
      operationId: pagamento.id,
      platformId,
      campaignId: pagamento.intencao.idCampanha,
      provider: 'stripe',
      method: pagamento.intencao.metodo,
      capabilityHash,
      requestHmac,
      snapshot,
      now: t0,
    });
    const stale = await repo.claim({
      operationId: pagamento.id,
      capabilityHash,
      requestHmac,
      now: t0,
      leaseUntil: new Date(t0.getTime() + 1),
    });
    const t1 = new Date(t0.getTime() + 2);
    const current = await repo.claim({
      operationId: pagamento.id,
      capabilityHash,
      requestHmac,
      now: t1,
      leaseUntil: new Date(t1.getTime() + 30_000),
    });
    if (stale.status !== 'claimed' || current.status !== 'claimed') throw new Error('claims');

    await expect(
      repo.completeAttempt({
        operationId: pagamento.id,
        attemptNo: stale.attemptNo,
        fenceToken: stale.fenceToken,
        outcome: 'provider_succeeded',
        diagnostic: null,
        providerRef: 'cs_stale',
        providerExpiresAt: null,
        now: t1,
      }),
    ).resolves.toBe(false);
    await expect(
      repo.completeAttempt({
        operationId: pagamento.id,
        attemptNo: current.attemptNo,
        fenceToken: current.fenceToken,
        outcome: 'provider_succeeded',
        diagnostic: null,
        providerRef: 'cs_current',
        providerExpiresAt: null,
        now: t1,
      }),
    ).resolves.toBe(true);
    await expect(
      repo.commitLocal({
        operationId: pagamento.id,
        fenceToken: current.fenceToken,
        providerRef: 'cs_current',
        providerExpiresAt: null,
        now: t1,
      }),
    ).resolves.toBe(true);
    await expect(repo.findById(pagamento.id)).resolves.toMatchObject({
      state: 'local_committed',
      providerRef: 'cs_current',
    });
    const payment = await new PagamentoRepositoryPostgres(testDb.db).findById(pagamento.id);
    expect(payment?.intencao.externalRef).toBe('cs_current');
  });

  it('keeps provider-only PIX facts out of reconciliation until local commit is durable', async () => {
    const { pagamento, snapshot: stripeSnapshot, platformId } = buildFixture();
    const txid = pagamento.id.replaceAll('-', '');
    const snapshot: CheckoutOperationSnapshot = {
      operationId: stripeSnapshot.operationId,
      platformId: stripeSnapshot.platformId,
      campaignId: stripeSnapshot.campaignId,
      paymentId: stripeSnapshot.paymentId,
      intentId: stripeSnapshot.intentId,
      method: 'pix',
      provider: 'inter',
      items: stripeSnapshot.items,
      totalChargedCents: stripeSnapshot.totalChargedCents,
      totalReceiverCents: stripeSnapshot.totalReceiverCents,
      totalSurchargeCents: stripeSnapshot.totalSurchargeCents,
      idempotencyKey: txid,
      txid,
      expirationSeconds: 600,
    };
    await seedPagamentoParents(testDb.db, pagamento);
    const operations = new CheckoutOperationRepositoryPostgres(testDb.db);
    const payments = new PagamentoRepositoryPostgres(testDb.db);
    const startedAt = new Date('2026-09-09T12:00:00Z');
    const expiredAt = new Date('2026-09-09T12:10:00Z');
    await operations.prepare({
      pagamento,
      operationId: pagamento.id,
      platformId,
      campaignId: pagamento.intencao.idCampanha,
      provider: 'inter',
      method: 'pix',
      capabilityHash,
      requestHmac,
      snapshot,
      now: startedAt,
    });
    const claim = await operations.claim({
      operationId: pagamento.id,
      capabilityHash,
      requestHmac,
      now: startedAt,
      leaseUntil: new Date(startedAt.getTime() + 30_000),
    });
    if (claim.status !== 'claimed') throw new Error('expected Inter provider claim');
    await expect(
      operations.completeAttempt({
        operationId: pagamento.id,
        attemptNo: claim.attemptNo,
        fenceToken: claim.fenceToken,
        outcome: 'provider_succeeded',
        diagnostic: null,
        providerRef: txid,
        providerExpiresAt: expiredAt,
        now: startedAt,
      }),
    ).resolves.toBe(true);

    // Model the historical partial-save hazard explicitly: even if a payment
    // row already carries the provider reference, the operation fact has not
    // reached local_committed and must not enter the settlement worker.
    await sql`
      UPDATE pagamentos
      SET intencao_external_ref = ${txid}, intencao_expira_em = ${expiredAt}
      WHERE id = ${pagamento.id}::uuid
    `.execute(testDb.db);
    const reconcileAt = new Date('2026-09-09T12:11:00Z');
    await expect(
      payments.claimPixCobrancaReconciliationCandidates({
        now: reconcileAt,
        leaseUntil: new Date(reconcileAt.getTime() + 60_000),
        limit: 1,
      }),
    ).resolves.toEqual([]);

    await expect(
      operations.commitLocal({
        operationId: pagamento.id,
        fenceToken: claim.fenceToken,
        providerRef: txid,
        providerExpiresAt: expiredAt,
        now: reconcileAt,
      }),
    ).resolves.toBe(true);
    await expect(
      payments.claimPixCobrancaReconciliationCandidates({
        now: reconcileAt,
        leaseUntil: new Date(reconcileAt.getTime() + 60_000),
        limit: 1,
      }),
    ).resolves.toEqual([{ idPagamento: pagamento.id, txid, expiraEm: expiredAt }]);
  });
});
