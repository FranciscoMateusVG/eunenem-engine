/**
 * Tests for aperture-v4ax3 — retroactive orphan-relink sweep.
 *
 * Symptom (operator's PIX walk 2026-06-04): payment_intent.* + charge.*
 * events archive as orphans (pagamento_id NULL) because they arrive
 * BEFORE checkout.session.completed has populated the pagamento's
 * payment_intent_external_ref column. When cs.completed later fires,
 * the lookup at THAT point works (session id matches) AND we now
 * persist pi onto the pagamento — but the earlier already-archived
 * orphans stay unlinked.
 *
 * Fix shape: cs.completed handler, right after persisting pi, sweeps
 * the archive for orphans whose raw_payload references this pi
 * (either as `data.object.id` for pi.* events, or as
 * `data.object.payment_intent` for charge.* events) and stamps
 * `pagamento_id` onto them.
 *
 * These tests exercise:
 *   (a) Port surface — relinkOrphansByPaymentIntent matches the
 *       2-axis predicate (id-vs-payment_intent) AND filters on
 *       pagamento_id IS NULL (idempotency).
 *   (b) Dispatcher wiring — cs.completed fires the sweep when it
 *       persists a fresh pi; doesn't fire when pi was already
 *       populated; doesn't fire when no pi in the payload.
 */

import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { dispatchVerifiedStripeEvent } from '../../apps/eunenem-server/server/webhooks/stripe-webhook.ts';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';

// ────────────────────────────────────────────────────────────────────
//  (a) PORT-LEVEL TESTS — WebhookEventArchiveMemory.relinkOrphansByPaymentIntent
// ────────────────────────────────────────────────────────────────────

describe('WebhookEventArchive.relinkOrphansByPaymentIntent', () => {
  it('relinks pi.* events whose data.object.id matches the pi', async () => {
    const archive = new WebhookEventArchiveMemory();
    const pi = `pi_test_${randomUUID()}`;

    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const updated = await archive.relinkOrphansByPaymentIntent(pi, 'pagamento-xyz');
    expect(updated).toBe(1);
  });

  it('relinks charge.* events whose data.object.payment_intent matches the pi', async () => {
    const archive = new WebhookEventArchiveMemory();
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;

    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const updated = await archive.relinkOrphansByPaymentIntent(pi, 'pagamento-xyz');
    expect(updated).toBe(1);
  });

  it('relinks mixed pi.* + charge.* orphans in one sweep (the operator-observed scenario)', async () => {
    const archive = new WebhookEventArchiveMemory();
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;

    // The 4-orphan PIX trail: requires_action, created, succeeded, charge.succeeded
    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.requires_action',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.created',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const updated = await archive.relinkOrphansByPaymentIntent(pi, 'pagamento-xyz');
    expect(updated).toBe(4);
  });

  it('skips non-orphan rows (idempotency anchor): re-firing produces zero updates', async () => {
    const archive = new WebhookEventArchiveMemory();
    const pi = `pi_test_${randomUUID()}`;
    const evtId = `evt_${randomUUID()}`;

    const ev = await archive.saveReceived({
      provider: 'stripe',
      providerEventId: evtId,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await archive.markProcessed(ev.id, 'pagamento-xyz');

    // First sweep: row already has pagamento_id set, no orphan to update.
    const updated = await archive.relinkOrphansByPaymentIntent(pi, 'pagamento-xyz');
    expect(updated).toBe(0);
  });

  it('ignores rows whose pi differs (no false positives)', async () => {
    const archive = new WebhookEventArchiveMemory();
    const piOurs = `pi_ours_${randomUUID()}`;
    const piOther = `pi_other_${randomUUID()}`;

    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: { data: { object: { id: piOther } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const updated = await archive.relinkOrphansByPaymentIntent(piOurs, 'pagamento-xyz');
    expect(updated).toBe(0);
  });

  it('tolerates payloads missing data.object (defensive)', async () => {
    const archive = new WebhookEventArchiveMemory();
    const pi = `pi_test_${randomUUID()}`;

    await archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'malformed',
      rawPayload: { not: 'a stripe event' },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const updated = await archive.relinkOrphansByPaymentIntent(pi, 'pagamento-xyz');
    expect(updated).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
//  (b) DISPATCHER WIRING — cs.completed sweeps after pi persistence
// ────────────────────────────────────────────────────────────────────

interface TestRig {
  deps: ServerDeps;
  archive: WebhookEventArchiveMemory;
  pagamentoRepository: PagamentoRepositoryMemory;
}

function buildRig(): TestRig {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const provider = new PagamentoProviderFake();
  const archive = new WebhookEventArchiveMemory();

  const deps = {
    db: {} as never,
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
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa: {} as never,
    observability,
    clock: () => new Date('2026-06-04T12:00:00.000Z'),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive: archive,
  } as unknown as ServerDeps;

  return { deps, archive, pagamentoRepository };
}

async function seedPagamento(rig: TestRig, sessionId: string): Promise<string> {
  const idPagamento = randomUUID();
  const idContribuicao = randomUUID();
  const idCampanha = randomUUID();

  await rig.deps.campanhaRepository.save({
    id: idCampanha as never,
    idPlataforma: randomUUID() as never,
    idsAdministradores: [],
    titulo: 't',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);
  await rig.deps.contribuicaoRepository.save({
    id: idContribuicao as never,
    idCampanha: idCampanha as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: 't',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  } as never);

  const pagamento = makePagamento({
    id: idPagamento,
    idContribuicao,
    idCampanha,
    metodo: 'pix',
    externalRef: sessionId,
    criadoEm: new Date('2026-06-04T12:00:00.000Z'),
  });
  await rig.pagamentoRepository.save(pagamento);
  return idPagamento;
}

function makeEvent(type: string, data: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: 'event',
    api_version: '2024-04-10',
    created: 1717000000,
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: data as unknown as Stripe.Event.Data.Object },
  } as unknown as Stripe.Event;
}

const noopSpan = trace.getTracer('test').startSpan('test');

describe('cs.completed dispatcher: retroactive orphan sweep (aperture-v4ax3)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('relinks 4 pre-existing orphans when cs.completed persists pi for the first time', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, sessionId);

    // Seed the 4 orphan events that arrived BEFORE cs.completed.
    for (const eventType of [
      'payment_intent.requires_action',
      'payment_intent.created',
      'payment_intent.succeeded',
    ]) {
      await rig.archive.saveReceived({
        provider: 'stripe',
        providerEventId: `evt_${randomUUID()}`,
        eventType,
        rawPayload: { data: { object: { id: pi } } },
        signatureHeader: 't=ok',
        signatureValid: true,
      });
    }
    await rig.archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'charge.succeeded',
      rawPayload: { data: { object: { id: ch, payment_intent: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    // Now cs.completed arrives.
    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: pi,
      payment_status: 'processing',
      customer_details: { email: 'v@example.com' },
      custom_fields: [{ key: 'nome', text: { value: 'V' } }],
    });
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);

    // All 4 orphans now linked.
    const linked = await rig.archive.findByPagamentoId(idPagamento);
    expect(linked.length).toBe(4);
  });

  it('does not sweep when pi was already persisted (idempotency: no fresh-pi event)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, sessionId);

    // Persist pi up front (simulates the cs.completed having fired once already).
    const initial = await rig.pagamentoRepository.findById(idPagamento as never);
    if (!initial) throw new Error('seed failed');
    await rig.pagamentoRepository.update({
      ...initial,
      intencao: { ...initial.intencao, paymentIntentExternalRef: pi },
    });

    // Now a hypothetical orphan exists — it's an old archive row that was
    // never linked. Without a *change* in pi persistence, the dispatcher
    // should NOT sweep (the if-block doesn't fire). This is the
    // idempotency contract: re-firing cs.completed on the same session
    // is a no-op for orphan-relinking.
    await rig.archive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment_intent.created',
      rawPayload: { data: { object: { id: pi } } },
      signatureHeader: 't=ok',
      signatureValid: true,
    });

    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: pi,
      payment_status: 'processing',
    });
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);

    // The orphan stays unlinked — the sweep didn't fire because pi was
    // already persisted (the if (pi !== existing) check short-circuited).
    // Operator-side: this is the "replay" path; a fresh cs.completed for
    // a new pi would have fired the sweep correctly.
    const linked = await rig.archive.findByPagamentoId(idPagamento);
    expect(linked.length).toBe(0);
  });

  it('does not crash when no orphans exist (relinkedCount === 0 is logged but ok)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, sessionId);

    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: pi,
      payment_status: 'processing',
    });
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);

    // pi is now persisted on the pagamento; no orphans existed.
    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.paymentIntentExternalRef).toBe(pi);
  });
});
