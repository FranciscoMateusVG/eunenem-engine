import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { createStripeWebhookHandler } from '../../apps/eunenem-server/server/webhooks/stripe-webhook.js';
import { __resetStripeForTests } from '../../apps/eunenem-server/src/lib/stripe/stripe.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { WebhookEventArchivePostgres } from '../../src/adapters/webhook-archive/webhook-event-archive.postgres.js';
import type { Pagamento } from '../../src/domain/pagamentos/entities/pagamento.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

const WEBHOOK_SECRET = 'whsec_projection_race_composition';
const STRIPE_SECRET_KEY = 'sk_test_projection_race_composition';
const NOW = new Date('2026-08-30T12:00:00.000Z');
const AVAILABLE_ON = NOW;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stripeEvent(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: 'event',
    api_version: '2025-08-27.basil',
    created: Math.floor(NOW.getTime() / 1000),
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: object as Stripe.Event.Data.Object },
  } as Stripe.Event;
}

function signedRequest(app: Hono, event: Stripe.Event): Promise<Response> {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_SECRET_KEY).webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return app.request('/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    body: payload,
  });
}

interface CompositionRig {
  app: Hono;
  pagamentoRepository: PagamentoRepositoryPostgres;
  archive: WebhookEventArchivePostgres;
  publisher: PagamentoEventPublisherMemory;
  receipts: Pagamento[];
  transactionId: string;
  seed: (args: {
    sessionId: string;
    paymentIntentId: string;
    chargeId: string;
    contributorEmail: string;
  }) => Promise<string>;
}

function buildComposition(testDb: TestDatabase): CompositionRig {
  const pagamentoRepository = new PagamentoRepositoryPostgres(testDb.db);
  const archive = new WebhookEventArchivePostgres(testDb.db);
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const publisher = new PagamentoEventPublisherMemory();
  const receipts: Pagamento[] = [];
  const transactionId = randomUUID();
  const provider = new PagamentoProviderFake({
    idTransacaoFactory: () => transactionId,
    clock: () => NOW,
  });
  const deps = {
    db: testDb.db,
    auth: {} as never,
    authService: {} as never,
    usuarioRepository: {} as never,
    plataformaRepository: {} as never,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    pagamentoRepository,
    pagamentoProvider: provider,
    checkoutSessionProvider: provider,
    pagamentoEventPublisher: publisher,
    livroFinanceiroRepository,
    provedorRegraTaxa: {} as never,
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
    clock: () => NOW,
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaa',
    webhookEventArchive: archive,
    pixReceiptNotifier: async (pagamento: Pagamento) => {
      receipts.push(pagamento);
    },
  } as unknown as ServerDeps;
  const app = new Hono();
  app.post('/api/webhooks/stripe', createStripeWebhookHandler(deps));

  return {
    app,
    pagamentoRepository,
    archive,
    publisher,
    receipts,
    transactionId,
    seed: async ({ sessionId, paymentIntentId, chargeId, contributorEmail }) => {
      const idPagamento = randomUUID();
      const idContribuicao = randomUUID();
      const idCampanha = randomUUID();
      const idOpcao = randomUUID();
      const idPlataforma = randomUUID();
      await campanhaRepository.save({
        id: idCampanha as never,
        idPlataforma: idPlataforma as never,
        idsAdministradores: [],
        titulo: 'Projection race campaign',
        opcoes: [],
        idRecebedor: null,
        dadosRecebedor: null,
        criadaEm: NOW,
      } as never);
      await contribuicaoRepository.save({
        id: idContribuicao as never,
        idCampanha: idCampanha as never,
        idOpcaoContribuicao: idOpcao as never,
        nome: 'Projection race contribution',
        valor: 4500 as never,
        imagemUrl: null,
        grupo: null,
        criadaEm: NOW,
      } as never);
      const pagamento = makePagamento({
        id: idPagamento,
        idContribuicao,
        idCampanha,
        metodo: 'pix',
        contributionUnitAmountCents: 4500,
        feeUnitAmountCents: 225,
        surchargeCents: 0,
        valorACobrarCents: 4725,
        externalRef: sessionId,
        criadoEm: NOW,
      });
      await seedPagamentoParents(testDb.db, pagamento);
      await pagamentoRepository.save(pagamento);
      await pagamentoRepository.updateProviderProjection(
        pagamento.id,
        { paymentIntentExternalRef: paymentIntentId, chargeExternalRef: chargeId },
        NOW,
      );
      await pagamentoRepository.setContribuinteIfAbsent(
        pagamento.id,
        { nome: 'Projection Race', email: contributorEmail },
        NOW,
      );
      return idPagamento;
    },
  };
}

let testDb: TestDatabase;
const previousStripeSecret = process.env.STRIPE_SECRET_KEY;
const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  __resetStripeForTests();
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
  if (previousStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = previousStripeSecret;
  if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  __resetStripeForTests();
});

beforeEach(async () => {
  await truncatePagamentosTables(testDb.db);
});

describe('mounted signed Stripe route + real Postgres projection race', () => {
  it('preserves the committed approval when a stale provider projection resumes after it', async () => {
    const rig = buildComposition(testDb);
    const sessionId = `cs_test_${randomUUID()}`;
    const paymentIntentId = `pi_test_${randomUUID()}`;
    const chargeId = `ch_test_${randomUUID()}`;
    const contributorEmail = 'projection-race@example.com';
    const idPagamento = await rig.seed({
      sessionId,
      paymentIntentId,
      chargeId,
      contributorEmail,
    });
    const projectionEntered = deferred();
    const allowProjectionCommit = deferred();
    const originalProjection = rig.pagamentoRepository.updateProviderProjection.bind(
      rig.pagamentoRepository,
    );
    let projectionCalls = 0;
    rig.pagamentoRepository.updateProviderProjection = async (...args) => {
      projectionCalls += 1;
      if (projectionCalls === 1) {
        projectionEntered.resolve();
        await allowProjectionCommit.promise;
      }
      return originalProjection(...args);
    };

    const unpaidEvent = stripeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: paymentIntentId,
      payment_status: 'unpaid',
      customer_details: { email: contributorEmail },
      custom_fields: [{ key: 'nome', text: { value: 'Projection Race' } }],
    });
    const chargeEvent = stripeEvent('charge.succeeded', {
      id: chargeId,
      payment_intent: paymentIntentId,
    });

    const unpaidResponse = signedRequest(rig.app, unpaidEvent);
    await projectionEntered.promise;
    const chargeResponse = await signedRequest(rig.app, chargeEvent);
    expect(chargeResponse.status).toBe(200);
    allowProjectionCommit.resolve();
    expect((await unpaidResponse).status).toBe(200);

    const canonical = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(canonical).toMatchObject({
      status: 'aprovado',
      transacaoExterna: {
        id: rig.transactionId,
        provedor: 'fake-provider',
        status: 'aprovado',
        amountCents: 4725,
      },
      intencao: {
        paymentIntentExternalRef: paymentIntentId,
        chargeExternalRef: chargeId,
        balanceTransactionAvailableOn: AVAILABLE_ON,
        contribuinte: { nome: 'Projection Race', email: contributorEmail },
      },
    });

    const unpaidArchive = await rig.archive.findByProviderEventId('stripe', unpaidEvent.id);
    const chargeArchive = await rig.archive.findByProviderEventId('stripe', chargeEvent.id);
    expect(unpaidArchive).toMatchObject({
      pagamentoId: idPagamento,
      signatureValid: true,
      processedAt: expect.any(Date),
      processingError: null,
    });
    expect(chargeArchive).toMatchObject({
      pagamentoId: idPagamento,
      signatureValid: true,
      processedAt: expect.any(Date),
      processingError: null,
    });
    const approvalEvents = rig.publisher
      .getEventosPublicados()
      .filter((event) => event.tipo === 'payment.approved');
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]).toMatchObject({
      idPagamento,
      idTransacaoExterna: rig.transactionId,
    });
    expect(rig.receipts).toHaveLength(1);
    expect(rig.receipts[0]).toMatchObject({
      id: idPagamento,
      status: 'aprovado',
      transacaoExterna: { id: rig.transactionId },
      intencao: {
        paymentIntentExternalRef: paymentIntentId,
        chargeExternalRef: chargeId,
        contribuinte: { email: contributorEmail },
      },
    });
  });

  it('archives a conflicting non-null provider identity as failed without side effects', async () => {
    const rig = buildComposition(testDb);
    const sessionId = `cs_test_${randomUUID()}`;
    const canonicalPaymentIntentId = `pi_canonical_${randomUUID()}`;
    const conflictingPaymentIntentId = `pi_conflict_${randomUUID()}`;
    const chargeId = `ch_test_${randomUUID()}`;
    const contributorEmail = 'identity-conflict@example.com';
    const idPagamento = await rig.seed({
      sessionId,
      paymentIntentId: canonicalPaymentIntentId,
      chargeId,
      contributorEmail,
    });
    const event = stripeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: conflictingPaymentIntentId,
      payment_status: 'unpaid',
      customer_details: { email: contributorEmail },
      custom_fields: [{ key: 'nome', text: { value: 'Identity Conflict' } }],
    });

    const response = await signedRequest(rig.app, event);

    expect(response.status).toBe(500);
    const archived = await rig.archive.findByProviderEventId('stripe', event.id);
    expect(archived).toMatchObject({
      pagamentoId: null,
      signatureValid: true,
      processedAt: null,
      processingError: expect.stringContaining('paymentIntentExternalRef'),
    });
    await expect(rig.pagamentoRepository.findById(idPagamento as never)).resolves.toMatchObject({
      status: 'pendente',
      transacaoExterna: undefined,
      intencao: {
        paymentIntentExternalRef: canonicalPaymentIntentId,
        chargeExternalRef: chargeId,
        balanceTransactionAvailableOn: null,
        contribuinte: { email: contributorEmail },
      },
    });
    expect(rig.publisher.getEventosPublicados()).toHaveLength(0);
    expect(rig.receipts).toHaveLength(0);
  });
});
