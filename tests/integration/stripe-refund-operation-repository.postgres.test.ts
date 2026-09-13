import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/adapters/database.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { acquirePaymentMoneyMovementLocks } from '../../src/adapters/pagamentos/payment-money-movement-lock.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { StripeRefundOperationRepositoryPostgres } from '../../src/adapters/pagamentos/stripe-refund-operation-repository.postgres.js';
import {
  aprovarPagamentoPendente,
  type Pagamento,
} from '../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type {
  IdLancamentoFinanceiro,
  IdRepasse,
} from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import type { IdPagamento } from '../../src/domain/pagamentos/value-objects/ids.js';
import { FinanceiroPagamentoMovimentacaoConflitanteError } from '../../src/errors/pagamentos/financeiro/pagamento-movimentacao-conflitante.error.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

let testDb: TestDatabase;
let dbA: Database;
let dbB: Database;

beforeAll(async () => {
  testDb = await createTestDatabase();
  dbA = createDatabase(testDb.connectionUri);
  dbB = createDatabase(testDb.connectionUri);
}, 60_000);

afterAll(async () => {
  await resetState();
  await dbA.destroy();
  await dbB.destroy();
  await testDb.teardown();
});

async function resetState(): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: cleanup spans finance tables outside the generated repository surface
  const db = testDb.db as any;
  await db.deleteFrom('repasse_reconciliacao_candidatos').execute();
  await db.deleteFrom('repasse_transfer_attempts').execute();
  await db.deleteFrom('lancamentos_financeiros').execute();
  await db.deleteFrom('repasses_recebedor').execute();
  await truncatePagamentosTables(testDb.db);
}

interface SeededRefundPayment {
  readonly payment: Pagamento;
  readonly chargeRef: string;
  readonly paymentIntentRef: string;
}

async function seedApprovedStripePayment(): Promise<SeededRefundPayment> {
  const pending = makePagamento({
    id: randomUUID() as IdPagamento,
    metodo: 'credit_card',
    criadoEm: new Date('2026-09-13T12:00:00Z'),
  });
  const chargeRef = `ch_test_${randomUUID()}`;
  const paymentIntentRef = `pi_test_${randomUUID()}`;
  const withProviderRefs: Pagamento = {
    ...pending,
    intencao: {
      ...pending.intencao,
      chargeExternalRef: chargeRef,
      paymentIntentExternalRef: paymentIntentRef,
      balanceTransactionAvailableOn: new Date('2026-09-12T12:00:00Z'),
    },
  };
  const payment = aprovarPagamentoPendente(
    withProviderRefs,
    {
      id: chargeRef as never,
      provedor: 'stripe',
      status: 'aprovado',
      amountCents: withProviderRefs.intencao.composicaoValoresAggregate.totalPaidCents,
      criadaEm: new Date('2026-09-13T12:01:00Z'),
    },
    new Date('2026-09-13T12:01:00Z'),
  );
  await seedPagamentoParents(testDb.db, payment);
  await new PagamentoRepositoryPostgres(testDb.db).save(payment);
  return { payment, chargeRef, paymentIntentRef };
}

function reserveInput(seed: SeededRefundPayment) {
  return {
    operationId: randomUUID(),
    paymentId: seed.payment.id,
    amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
    currency: 'brl' as const,
    chargeRef: seed.chargeRef,
    paymentIntentRef: seed.paymentIntentRef,
    reason: 'requested_by_customer' as const,
    now: new Date('2026-09-13T12:02:00Z'),
  };
}

async function seedApprovedPayout(
  db: Database,
  seed: SeededRefundPayment,
): Promise<{ readonly repo: LivroFinanceiroRepositoryPostgres; readonly repasseId: IdRepasse }> {
  const repo = new LivroFinanceiroRepositoryPostgres(db);
  const repasseId = randomUUID() as IdRepasse;
  const repasse: RepasseRecebedor = {
    id: repasseId,
    idCampanha: seed.payment.intencao.idCampanha,
    amountCents: seed.payment.intencao.composicaoValoresAggregate.totalReceiverCents,
    status: 'solicitado',
    solicitadoEm: new Date('2026-09-13T12:00:00Z'),
    aprovadoEm: null,
    bankTransferRef: null,
    transferReferencia: null,
    interCodigoSolicitacao: null,
    transferAttempts: 0,
    lastTransferError: null,
    needsManualResolution: false,
  };
  await repo.saveRepasse(repasse);
  const contributionItem = seed.payment.intencao.items.find((item) => item.tipo === 'contribuicao');
  if (!contributionItem || contributionItem.tipo !== 'contribuicao') {
    throw new Error('expected contribution item');
  }
  const lancamento: LancamentoFinanceiro = {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: seed.payment.id,
    idItemPagamento: contributionItem.id,
    idContribuicao: contributionItem.idContribuicao,
    idCampanha: seed.payment.intencao.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: repasse.amountCents,
    criadoEm: new Date('2026-09-13T12:01:00Z'),
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: repasseId,
  };
  await repo.saveLancamentos([lancamento]);
  await repo.aprovarRepassePixTransaction(
    {
      idRepasse: repasseId,
      aprovadoEm: new Date('2026-09-13T12:01:00Z'),
      transferReferencia: `EN${String(repasseId).replaceAll('-', '')}`,
    },
    async () => {},
  );
  return { repo, repasseId };
}

async function withPaymentLockHeld(paymentId: string, run: () => Promise<void>): Promise<void> {
  let releaseLock: (() => void) | undefined;
  let signalLocked: (() => void) | undefined;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const holder = testDb.db.transaction().execute(async (tx) => {
    await acquirePaymentMoneyMovementLocks(tx, [paymentId]);
    signalLocked?.();
    await release;
  });
  await locked;
  try {
    await run();
  } finally {
    releaseLock?.();
    await holder;
  }
}

async function waitForAdvisoryLockWaiters(expected: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const waiting = await sql<{ count: string }>`
          SELECT count(*)::text AS count
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock%'
        `.execute(testDb.db);
        return Number(waiting.rows[0]?.count ?? 0);
      },
      { timeout: 5_000, interval: 10 },
    )
    .toBe(expected);
}

describe('Stripe refund operation durability and payout exclusion — Postgres', () => {
  beforeEach(resetState);

  it('serializes two concurrent claims to one provider admission across two pools', async () => {
    const seed = await seedApprovedStripePayment();
    const operation = await new StripeRefundOperationRepositoryPostgres(testDb.db).reserve(
      reserveInput(seed),
    );
    const [a, b] = await Promise.all([
      new StripeRefundOperationRepositoryPostgres(dbA).claimProviderStart(
        operation.operation.operationId,
        new Date('2026-09-13T12:03:00Z'),
      ),
      new StripeRefundOperationRepositoryPostgres(dbB).claimProviderStart(
        operation.operation.operationId,
        new Date('2026-09-13T12:03:00Z'),
      ),
    ]);

    expect([a.status, b.status].sort()).toEqual(['call_provider', 'provider_started']);
    // biome-ignore lint/suspicious/noExplicitAny: append-only evidence table assertion
    const facts = await (testDb.db as any)
      .selectFrom('stripe_refund_operation_facts')
      .selectAll()
      .where('fact_kind', '=', 'provider_started')
      .execute();
    expect(facts).toHaveLength(1);
  });

  it('numbers a retry after an exact refusal while an unknown attempt stays nonclaimable', async () => {
    const seed = await seedApprovedStripePayment();
    const repository = new StripeRefundOperationRepositoryPostgres(dbA);
    const reserved = await repository.reserve(reserveInput(seed));
    const first = await repository.claimProviderStart(
      reserved.operation.operationId,
      new Date('2026-09-13T12:03:00Z'),
    );
    if (first.status !== 'call_provider') throw new Error('expected attempt one');
    await repository.recordProviderResult({
      operationId: first.operation.operationId,
      attemptNo: first.attemptNo,
      outcome: 'provider_failed',
      providerRef: 're_failed_integration_1',
      providerStatus: 'failed',
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl',
      now: new Date('2026-09-13T12:04:00Z'),
    });
    const second = await repository.claimProviderStart(
      first.operation.operationId,
      new Date('2026-09-13T12:05:00Z'),
    );
    expect(second).toMatchObject({
      status: 'call_provider',
      attemptNo: 2,
      idempotencyKey: `pagamento:${seed.payment.id}:refund:2`,
    });
    if (second.status !== 'call_provider') throw new Error('expected attempt two');
    await repository.recordOutcomeUnknown(
      second.operation.operationId,
      second.attemptNo,
      new Date('2026-09-13T12:06:00Z'),
    );
    await expect(
      repository.claimProviderStart(second.operation.operationId, new Date('2026-09-13T12:07:00Z')),
    ).resolves.toMatchObject({ status: 'outcome_unknown', operation: { attemptCount: 2 } });

    // biome-ignore lint/suspicious/noExplicitAny: append-only evidence assertion
    const facts = await (testDb.db as any)
      .selectFrom('stripe_refund_operation_facts')
      .select(['attempt_no', 'fact_kind', 'idempotency_key'])
      .where('operation_id', '=', first.operation.operationId)
      .orderBy('attempt_no')
      .orderBy('fact_kind')
      .execute();
    expect(
      facts.filter((fact: { fact_kind: string }) => fact.fact_kind === 'provider_started'),
    ).toEqual([
      expect.objectContaining({
        attempt_no: 1,
        idempotency_key: `pagamento:${seed.payment.id}:refund:1`,
      }),
      expect.objectContaining({
        attempt_no: 2,
        idempotency_key: `pagamento:${seed.payment.id}:refund:2`,
      }),
    ]);
  });

  it('rolls payment, ledger, cursor and facts back when local convergence fails mid-transaction', async () => {
    const seed = await seedApprovedStripePayment();
    const { repo: ledger } = await seedApprovedPayout(testDb.db, seed);
    const repository = new StripeRefundOperationRepositoryPostgres(dbA);
    const reserved = await repository.reserve(reserveInput(seed));
    const claim = await repository.claimProviderStart(
      reserved.operation.operationId,
      new Date('2026-09-13T12:03:00Z'),
    );
    if (claim.status !== 'call_provider') throw new Error('expected provider admission');
    await repository.recordProviderResult({
      operationId: claim.operation.operationId,
      attemptNo: claim.attemptNo,
      outcome: 'provider_succeeded',
      providerRef: 're_succeeded_atomic_rollback',
      providerStatus: 'succeeded',
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl',
      now: new Date('2026-09-13T12:04:00Z'),
    });
    await sql`
      CREATE FUNCTION fail_stripe_refund_local_commit()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION 'synthetic local convergence failure';
      END
      $body$;
      CREATE TRIGGER fail_stripe_refund_local_commit
        BEFORE UPDATE ON stripe_refund_operations
        FOR EACH ROW WHEN (NEW.state = 'local_committed')
        EXECUTE FUNCTION fail_stripe_refund_local_commit();
    `.execute(testDb.db);

    try {
      await expect(
        repository.convergeSuccessful(
          reserved.operation.operationId,
          new Date('2026-09-13T12:05:00Z'),
        ),
      ).rejects.toThrow('synthetic local convergence failure');

      expect((await repository.findByPaymentId(seed.payment.id))?.state).toBe('provider_succeeded');
      expect(
        (await new PagamentoRepositoryPostgres(testDb.db).findById(seed.payment.id))?.status,
      ).toBe('aprovado');
      expect(
        (await ledger.findLancamentosByIdPagamento(seed.payment.id)).every(
          (entry) => entry.canceladoEm === null,
        ),
      ).toBe(true);
      // biome-ignore lint/suspicious/noExplicitAny: atomic evidence assertion
      const localFacts = await (testDb.db as any)
        .selectFrom('stripe_refund_operation_facts')
        .selectAll()
        .where('operation_id', '=', reserved.operation.operationId)
        .where('fact_kind', '=', 'local_committed')
        .execute();
      expect(localFacts).toHaveLength(0);
    } finally {
      await sql`
        DROP TRIGGER IF EXISTS fail_stripe_refund_local_commit ON stripe_refund_operations;
        DROP FUNCTION IF EXISTS fail_stripe_refund_local_commit();
      `.execute(testDb.db);
    }
  });

  it('refund-first waiter wins the shared lock and blocks concurrent payout admission', async () => {
    const seed = await seedApprovedStripePayment();
    const { repo: payoutRepo, repasseId } = await seedApprovedPayout(dbB, seed);
    let refund: Promise<unknown> | undefined;
    let payout: Promise<unknown> | undefined;
    await withPaymentLockHeld(seed.payment.id, async () => {
      refund = new StripeRefundOperationRepositoryPostgres(dbA).reserve(reserveInput(seed));
      await waitForAdvisoryLockWaiters(1);
      payout = payoutRepo.iniciarTransferenciaTransaction({
        idRepasse: repasseId,
        requestSummary: 'pagarPix valor=8400',
        agora: new Date('2026-09-13T12:03:00Z'),
      });
      await waitForAdvisoryLockWaiters(2);
    });

    if (!refund || !payout) throw new Error('concurrent refund/payout did not start');
    await expect(refund).resolves.toMatchObject({ created: true });
    await expect(payout).rejects.toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
    expect((await payoutRepo.findRepasseById(repasseId))?.status).toBe('aprovado');
  });

  it('payout-first waiter wins the shared lock and blocks concurrent refund admission', async () => {
    const seed = await seedApprovedStripePayment();
    const { repo: payoutRepo, repasseId } = await seedApprovedPayout(dbA, seed);
    let payout: Promise<unknown> | undefined;
    let refund: Promise<unknown> | undefined;
    await withPaymentLockHeld(seed.payment.id, async () => {
      payout = payoutRepo.iniciarTransferenciaTransaction({
        idRepasse: repasseId,
        requestSummary: 'pagarPix valor=8400',
        agora: new Date('2026-09-13T12:03:00Z'),
      });
      await waitForAdvisoryLockWaiters(1);
      refund = new StripeRefundOperationRepositoryPostgres(dbB).reserve(reserveInput(seed));
      await waitForAdvisoryLockWaiters(2);
    });

    if (!refund || !payout) throw new Error('concurrent payout/refund did not start');
    await expect(payout).resolves.toMatchObject({ acao: 'prosseguir' });
    await expect(refund).rejects.toBeInstanceOf(FinanceiroPagamentoMovimentacaoConflitanteError);
    expect((await payoutRepo.findRepasseById(repasseId))?.status).toBe('transferindo');
  });

  it('commits a unique held webhook fact when payout already won, including an absent cursor', async () => {
    const seed = await seedApprovedStripePayment();
    const { repo: payoutRepo, repasseId } = await seedApprovedPayout(dbA, seed);
    await payoutRepo.iniciarTransferenciaTransaction({
      idRepasse: repasseId,
      requestSummary: 'pagarPix valor=8400',
      agora: new Date('2026-09-13T12:03:00Z'),
    });
    const repository = new StripeRefundOperationRepositoryPostgres(dbB);
    const event = {
      eventId: `evt_${randomUUID()}`,
      operationId: randomUUID(),
      paymentId: seed.payment.id,
      chargeRef: seed.chargeRef,
      paymentIntentRef: seed.paymentIntentRef,
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl' as const,
      now: new Date('2026-09-13T12:04:00Z'),
    };

    await expect(repository.observeVerifiedAndConverge(event)).resolves.toEqual({
      status: 'held_conflict',
    });
    await expect(repository.observeVerifiedAndConverge(event)).resolves.toEqual({
      status: 'held_conflict',
    });
    expect((await repository.findByPaymentId(seed.payment.id))?.state).toBe('outcome_unknown');
    // biome-ignore lint/suspicious/noExplicitAny: append-only evidence table assertion
    const facts = await (testDb.db as any)
      .selectFrom('stripe_refund_operation_facts')
      .selectAll()
      .where('provider_event_id', '=', event.eventId)
      .execute();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact_kind).toBe('provider_observed_conflict');
  });

  it('preserves the distinct observed webhook tuple when an existing cursor binding conflicts', async () => {
    const seed = await seedApprovedStripePayment();
    const repository = new StripeRefundOperationRepositoryPostgres(dbA);
    const reserved = await repository.reserve(reserveInput(seed));
    const observed = {
      eventId: `evt_${randomUUID()}`,
      operationId: randomUUID(),
      paymentId: seed.payment.id,
      chargeRef: `ch_observed_${randomUUID()}`,
      paymentIntentRef: `pi_observed_${randomUUID()}`,
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl' as const,
      now: new Date('2026-09-13T12:04:00Z'),
    };

    await expect(repository.observeVerifiedAndConverge(observed)).resolves.toEqual({
      status: 'held_conflict',
    });

    const cursor = await repository.findByPaymentId(seed.payment.id);
    expect(cursor).toMatchObject({
      operationId: reserved.operation.operationId,
      chargeRef: seed.chargeRef,
      paymentIntentRef: seed.paymentIntentRef,
      state: 'outcome_unknown',
    });
    // biome-ignore lint/suspicious/noExplicitAny: append-only evidence table assertion
    const fact = await (testDb.db as any)
      .selectFrom('stripe_refund_operation_facts')
      .selectAll()
      .where('provider_event_id', '=', observed.eventId)
      .executeTakeFirstOrThrow();
    expect(fact).toMatchObject({
      fact_kind: 'provider_observed_conflict',
      observed_charge_ref: observed.chargeRef,
      observed_payment_intent_ref: observed.paymentIntentRef,
      observed_amount_cents: String(observed.amountCents),
      observed_currency: observed.currency,
    });
  });

  it('keeps pending nonterminal, then converges once from verified full-refund evidence', async () => {
    const seed = await seedApprovedStripePayment();
    const repository = new StripeRefundOperationRepositoryPostgres(dbA);
    const reserved = await repository.reserve(reserveInput(seed));
    const claim = await repository.claimProviderStart(
      reserved.operation.operationId,
      new Date('2026-09-13T12:03:00Z'),
    );
    if (claim.status !== 'call_provider') throw new Error('expected provider admission');
    await repository.recordProviderResult({
      operationId: claim.operation.operationId,
      attemptNo: claim.attemptNo,
      outcome: 'provider_pending',
      providerRef: 're_pending_integration',
      providerStatus: 'pending',
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl',
      now: new Date('2026-09-13T12:04:00Z'),
    });

    await expect(
      repository.convergeSuccessful(
        reserved.operation.operationId,
        new Date('2026-09-13T12:05:00Z'),
      ),
    ).resolves.toEqual({ status: 'held_conflict' });
    expect(
      (await new PagamentoRepositoryPostgres(testDb.db).findById(seed.payment.id))?.status,
    ).toBe('aprovado');

    const event = {
      eventId: `evt_${randomUUID()}`,
      operationId: randomUUID(),
      paymentId: seed.payment.id,
      chargeRef: seed.chargeRef,
      paymentIntentRef: seed.paymentIntentRef,
      amountCents: seed.payment.intencao.composicaoValoresAggregate.totalPaidCents,
      currency: 'brl' as const,
      now: new Date('2026-09-13T12:06:00Z'),
    };
    await expect(repository.observeVerifiedAndConverge(event)).resolves.toEqual({
      status: 'converged',
    });
    await expect(repository.observeVerifiedAndConverge(event)).resolves.toEqual({
      status: 'already_converged',
    });
    expect((await repository.findByPaymentId(seed.payment.id))?.state).toBe('local_committed');
    expect(
      (await new PagamentoRepositoryPostgres(testDb.db).findById(seed.payment.id))?.status,
    ).toBe('estornado');
  });
});
