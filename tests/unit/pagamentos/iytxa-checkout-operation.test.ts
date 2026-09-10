import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CheckoutOperationRepositoryMemory } from '../../../src/adapters/pagamentos/checkout-operation-repository.memory.js';

function snapshot(id: string) {
  return {
    operationId: id,
    platformId: randomUUID(),
    campaignId: randomUUID(),
    paymentId: id,
    intentId: randomUUID(),
    method: 'credit_card' as const,
    provider: 'stripe' as const,
    items: [
      {
        paymentItemId: randomUUID(),
        contributionId: randomUUID(),
        optionId: randomUUID(),
        optionType: 'presente',
        quantity: 1,
        contributionCents: 1000,
        feeCents: 100,
        receiverCents: 900,
        surchargeCents: 0,
      },
    ],
    totalChargedCents: 1100,
    totalReceiverCents: 900,
    totalSurchargeCents: 100,
    idempotencyKey: `pagamento:${id}:create-session`,
    anchorContributionId: randomUUID(),
    anchorOptionId: randomUUID(),
    anchorOptionType: 'presente',
    redirectOnCompletion: 'if_required' as const,
  };
}

function payment(id: string) {
  return {
    id,
    intencao: { externalRef: null, expiraEm: null },
    atualizadoEm: new Date('2026-09-09T00:00:00Z'),
  };
}

function rig() {
  const rows = new Map<string, ReturnType<typeof payment>>();
  const payments = {
    save: async (value: ReturnType<typeof payment>) => void rows.set(value.id, value),
    findById: async (id: string) => rows.get(id),
    update: async (value: ReturnType<typeof payment>) => void rows.set(value.id, value),
  };
  return {
    rows,
    repo: new CheckoutOperationRepositoryMemory(payments as never),
  };
}

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

describe('checkout operation durable state machine', () => {
  it('persists claim before I/O and leaves an honest unfinished attempt after a crash', async () => {
    const { repo } = rig();
    const id = randomUUID();
    const now = new Date('2026-09-09T12:00:00Z');
    const snap = snapshot(id);
    await repo.prepare({
      pagamento: payment(id) as never,
      operationId: id,
      platformId: snap.platformId,
      campaignId: snap.campaignId,
      provider: 'stripe',
      method: 'credit_card',
      capabilityHash: digestA,
      requestHmac: digestB,
      snapshot: snap,
      now,
    });

    const claim = await repo.claim({
      operationId: id,
      capabilityHash: digestA,
      requestHmac: digestB,
      now,
      leaseUntil: new Date(now.getTime() + 1_000),
    });
    expect(claim.status).toBe('claimed');
    expect(repo.listFactsForTests(id)).toMatchObject([
      { factKind: 'claim', attemptNo: 1, claimKind: 'create', priorState: 'reserved' },
    ]);
  });

  it('rejects a stale fence and only exposes local_committed after the current result', async () => {
    const { repo, rows } = rig();
    const id = randomUUID();
    const snap = snapshot(id);
    const t0 = new Date('2026-09-09T12:00:00Z');
    await repo.prepare({
      pagamento: payment(id) as never,
      operationId: id,
      platformId: snap.platformId,
      campaignId: snap.campaignId,
      provider: 'stripe',
      method: 'credit_card',
      capabilityHash: digestA,
      requestHmac: digestB,
      snapshot: snap,
      now: t0,
    });
    const first = await repo.claim({
      operationId: id,
      capabilityHash: digestA,
      requestHmac: digestB,
      now: t0,
      leaseUntil: new Date(t0.getTime() + 1),
    });
    if (first.status !== 'claimed') throw new Error('expected first claim');
    const t1 = new Date(t0.getTime() + 2);
    const second = await repo.claim({
      operationId: id,
      capabilityHash: digestA,
      requestHmac: digestB,
      now: t1,
      leaseUntil: new Date(t1.getTime() + 1_000),
    });
    if (second.status !== 'claimed') throw new Error('expected recovery claim');
    expect(
      await repo.completeAttempt({
        operationId: id,
        attemptNo: first.attemptNo,
        fenceToken: first.fenceToken,
        outcome: 'provider_succeeded',
        diagnostic: null,
        providerRef: 'cs_stale',
        providerExpiresAt: null,
        now: t1,
      }),
    ).toBe(false);
    expect(rows.get(id)?.intencao.externalRef).toBeNull();

    expect(
      await repo.completeAttempt({
        operationId: id,
        attemptNo: second.attemptNo,
        fenceToken: second.fenceToken,
        outcome: 'provider_succeeded',
        diagnostic: null,
        providerRef: 'cs_current',
        providerExpiresAt: null,
        now: t1,
      }),
    ).toBe(true);
    expect(
      await repo.commitLocal({
        operationId: id,
        fenceToken: second.fenceToken,
        providerRef: 'cs_current',
        providerExpiresAt: null,
        now: t1,
      }),
    ).toBe(true);
    expect(rows.get(id)?.intencao.externalRef).toBe('cs_current');
    expect((await repo.findById(id))?.state).toBe('local_committed');
    expect(repo.listFactsForTests(id).map((fact) => fact.factKind)).toEqual([
      'claim',
      'claim',
      'result',
    ]);
  });

  it('reuses Stripe create only inside 23 hours and never creates Inter again after dispatch', async () => {
    const stripeRig = rig();
    const stripeId = randomUUID();
    const stripeSnapshot = snapshot(stripeId);
    const t0 = new Date('2026-09-09T12:00:00Z');
    await stripeRig.repo.prepare({
      pagamento: payment(stripeId) as never,
      operationId: stripeId,
      platformId: stripeSnapshot.platformId,
      campaignId: stripeSnapshot.campaignId,
      provider: 'stripe',
      method: 'credit_card',
      capabilityHash: digestA,
      requestHmac: digestB,
      snapshot: stripeSnapshot,
      now: t0,
    });
    const firstStripe = await stripeRig.repo.claim({
      operationId: stripeId,
      capabilityHash: digestA,
      requestHmac: digestB,
      now: t0,
      leaseUntil: new Date(t0.getTime() + 1),
    });
    if (firstStripe.status !== 'claimed') throw new Error('expected first Stripe claim');
    await stripeRig.repo.completeAttempt({
      operationId: stripeId,
      attemptNo: firstStripe.attemptNo,
      fenceToken: firstStripe.fenceToken,
      outcome: 'outcome_unknown',
      diagnostic: 'transport',
      providerRef: null,
      providerExpiresAt: null,
      now: t0,
    });
    const withinWindow = new Date(t0.getTime() + 23 * 60 * 60 * 1000 - 1);
    const retry = await stripeRig.repo.claim({
      operationId: stripeId,
      capabilityHash: digestA,
      requestHmac: digestB,
      now: withinWindow,
      leaseUntil: new Date(withinWindow.getTime() + 1),
    });
    expect(retry).toMatchObject({ status: 'claimed', claimKind: 'create' });
    if (retry.status !== 'claimed') throw new Error('expected bounded Stripe replay');
    await stripeRig.repo.completeAttempt({
      operationId: stripeId,
      attemptNo: retry.attemptNo,
      fenceToken: retry.fenceToken,
      outcome: 'outcome_unknown',
      diagnostic: 'transport',
      providerRef: null,
      providerExpiresAt: null,
      now: withinWindow,
    });
    const cutoff = new Date(t0.getTime() + 23 * 60 * 60 * 1000);
    await expect(
      stripeRig.repo.claim({
        operationId: stripeId,
        capabilityHash: digestA,
        requestHmac: digestB,
        now: cutoff,
        leaseUntil: new Date(cutoff.getTime() + 1),
      }),
    ).resolves.toMatchObject({ status: 'expired_window' });

    const interRig = rig();
    const interId = randomUUID();
    const common = snapshot(interId);
    const interSnapshot = {
      operationId: common.operationId,
      platformId: common.platformId,
      campaignId: common.campaignId,
      paymentId: common.paymentId,
      intentId: common.intentId,
      method: 'pix' as const,
      provider: 'inter' as const,
      items: common.items,
      totalChargedCents: common.totalChargedCents,
      totalReceiverCents: common.totalReceiverCents,
      totalSurchargeCents: 0,
      idempotencyKey: interId.replaceAll('-', ''),
      txid: interId.replaceAll('-', ''),
      expirationSeconds: 600,
    };
    await interRig.repo.prepare({
      pagamento: payment(interId) as never,
      operationId: interId,
      platformId: interSnapshot.platformId,
      campaignId: interSnapshot.campaignId,
      provider: 'inter',
      method: 'pix',
      capabilityHash: digestA,
      requestHmac: digestB,
      snapshot: interSnapshot,
      now: t0,
    });
    const firstInter = await interRig.repo.claim({
      operationId: interId,
      capabilityHash: digestA,
      requestHmac: digestB,
      now: t0,
      leaseUntil: new Date(t0.getTime() + 1),
    });
    if (firstInter.status !== 'claimed') throw new Error('expected first Inter claim');
    await interRig.repo.completeAttempt({
      operationId: interId,
      attemptNo: firstInter.attemptNo,
      fenceToken: firstInter.fenceToken,
      outcome: 'outcome_unknown',
      diagnostic: 'transport',
      providerRef: null,
      providerExpiresAt: null,
      now: t0,
    });
    await expect(
      interRig.repo.claim({
        operationId: interId,
        capabilityHash: digestA,
        requestHmac: digestB,
        now: new Date(t0.getTime() + 2),
        leaseUntil: new Date(t0.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({ status: 'claimed', claimKind: 'reconcile' });
  });
});
