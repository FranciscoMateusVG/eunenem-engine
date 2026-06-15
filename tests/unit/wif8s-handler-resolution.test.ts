/**
 * Tests for aperture-wif8s — per-event-type webhook resolver +
 * pi_xxx / ch_xxx side-effect persistence.
 *
 * Covers the handler-level acceptance criteria from the bead:
 *   (e) checkout.session.completed: pagamento_id linked AND
 *       intencao.paymentIntentExternalRef populated
 *   (f) payment_intent.succeeded after cs.completed: pagamento_id
 *       linked via pi lookup AND intencao.chargeExternalRef
 *       populated from latest_charge
 *   (g) charge.succeeded with both pi+ch refs: pagamento_id linked
 *       via pi (primary path)
 *   (h) charge.succeeded when pi lookup misses but ch matches a
 *       backfilled chargeExternalRef: linked via ch fallback
 *   (i) payment_intent.succeeded arriving BEFORE checkout.session.completed:
 *       archived as orphan (returns pagamentoId: null), no error
 *   (j) Unknown event type: archived but NOT linked
 *
 * Uses in-memory adapters; no Stripe SDK signature math is exercised
 * here — the pipeline + signature verification are covered by
 * aperture-1n6u8's stripe-webhook-pipeline.test.ts. This file's
 * concern is what dispatchVerifiedStripeEvent does after the
 * signature checks have passed.
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
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';

interface TestRig {
  deps: ServerDeps;
  pagamentoRepository: PagamentoRepositoryMemory;
}

function buildRig(): TestRig {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const provider = new PagamentoProviderFake();

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
    clock: () => new Date('2026-06-02T12:00:00.000Z'),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaa',
    // aperture-v4ax3: cs.completed handler now calls
    // relinkOrphansByPaymentIntent on the archive after persisting pi.
    // Wire a real memory archive so the call doesn't crash on `{} as never`.
    webhookEventArchive: new WebhookEventArchiveMemory(),
  } as unknown as ServerDeps;

  return { deps, pagamentoRepository };
}

/** Seed a pagamento already bound to a Stripe session id (cs_xxx). */
async function seedPagamentoWithSession(
  rig: TestRig,
  sessionId: string,
): Promise<{ idPagamento: string; idContribuicao: string }> {
  const idPagamento = randomUUID();
  const idContribuicao = randomUUID();
  const pagamento = makePagamento({
    id: idPagamento,
    idContribuicao,
    metodo: 'pix',
    contributionUnitAmountCents: 4500,
    feeUnitAmountCents: 225,
    surchargeCents: 0,
    valorACobrarCents: 4725,
    externalRef: sessionId,
    criadoEm: new Date('2026-06-02T12:00:00.000Z'),
  });
  await rig.pagamentoRepository.save(pagamento);
  return { idPagamento, idContribuicao };
}

/** Set the pi ref on an existing pagamento (simulates cs.completed having run). */
async function bindPagamentoToPi(rig: TestRig, idPagamento: string, pi: string): Promise<void> {
  const pag = await rig.pagamentoRepository.findById(idPagamento as never);
  if (!pag) throw new Error('pagamento not seeded');
  await rig.pagamentoRepository.update({
    ...pag,
    intencao: { ...pag.intencao, paymentIntentExternalRef: pi },
  });
}

async function bindPagamentoToCh(rig: TestRig, idPagamento: string, ch: string): Promise<void> {
  const pag = await rig.pagamentoRepository.findById(idPagamento as never);
  if (!pag) throw new Error('pagamento not seeded');
  await rig.pagamentoRepository.update({
    ...pag,
    intencao: { ...pag.intencao, chargeExternalRef: ch },
  });
}

/**
 * Plan 0015 Phase 3 (aperture-ndxuf): the charge.succeeded dispatcher
 * now fires finalize-aprovado for non-terminal source states. For
 * link-only tests (wif8s g/h) that want to assert pagamento_id
 * resolution WITHOUT going through finalize, seed the pagamento as
 * already aprovado so the dispatcher's terminal-skip path runs.
 */
async function markPagamentoAprovado(rig: TestRig, idPagamento: string): Promise<void> {
  const pag = await rig.pagamentoRepository.findById(idPagamento as never);
  if (!pag) throw new Error('pagamento not seeded');
  await rig.pagamentoRepository.update({ ...pag, status: 'aprovado' as never });
}

/** Build a fake Stripe.Event payload — only the fields the handler reads. */
function makeStripeEvent(type: string, data: Record<string, unknown>): Stripe.Event {
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

describe('dispatchVerifiedStripeEvent (aperture-wif8s)', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = buildRig();
  });

  // ───── (e) checkout.session.completed: persists pi + links event ──

  it('(e) checkout.session.completed: links pagamento_id AND persists intencao.paymentIntentExternalRef from session.payment_intent', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const { idPagamento, idContribuicao } = await seedPagamentoWithSession(rig, sessionId);

    // Seed contribuicao + campanha so finalize doesn't blow up.
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
      valor: 4725 as never,
      status: 'disponivel',
      imagemUrl: null,
      grupo: null,
      criadaEm: new Date(),
      contribuinteNome: null,
      contribuinteEmail: null,
    } as never);

    const event = makeStripeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: piId,
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(idPagamento);

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.paymentIntentExternalRef).toBe(piId);
  });

  // ───── (f) payment_intent.succeeded after cs.completed: ch persisted ──

  it('(f) payment_intent.succeeded resolves via pi lookup AND persists intencao.chargeExternalRef from latest_charge', async () => {
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const { idPagamento } = await seedPagamentoWithSession(rig, `cs_test_${randomUUID()}`);
    await bindPagamentoToPi(rig, idPagamento, piId); // simulates prior cs.completed

    const event = makeStripeEvent('payment_intent.succeeded', {
      id: piId,
      latest_charge: chId,
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(idPagamento);

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.chargeExternalRef).toBe(chId);
  });

  it('(f-2) payment_intent.created: links via pi but does NOT touch ch (only succeeded persists ch)', async () => {
    const piId = `pi_test_${randomUUID()}`;
    const { idPagamento } = await seedPagamentoWithSession(rig, `cs_test_${randomUUID()}`);
    await bindPagamentoToPi(rig, idPagamento, piId);

    const event = makeStripeEvent('payment_intent.created', {
      id: piId,
      latest_charge: 'ch_should_be_ignored_on_created',
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(idPagamento);

    // ch should remain null — only payment_intent.succeeded persists it.
    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.chargeExternalRef).toBeNull();
  });

  // ───── (g) charge.succeeded: primary lookup via pi ────────────────

  it('(g) charge.succeeded with both pi and ch refs: links via pi (primary path)', async () => {
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const { idPagamento } = await seedPagamentoWithSession(rig, `cs_test_${randomUUID()}`);
    await bindPagamentoToPi(rig, idPagamento, piId);
    // Note: ch NOT bound — primary path should still resolve via pi.
    // Plan 0015 Phase 3: mark aprovado so the dispatcher's terminal-skip
    // path runs (this test asserts link-only resolution, not transition).
    await markPagamentoAprovado(rig, idPagamento);

    const event = makeStripeEvent('charge.succeeded', {
      id: chId,
      payment_intent: piId,
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(idPagamento);
  });

  // ───── (h) charge.succeeded fallback via ch ───────────────────────

  it('(h) charge.succeeded when pi lookup misses but ch matches a backfilled chargeExternalRef: links via ch fallback', async () => {
    const chId = `ch_test_${randomUUID()}`;
    const piIdUnknown = `pi_unknown_${randomUUID()}`;
    const { idPagamento } = await seedPagamentoWithSession(rig, `cs_test_${randomUUID()}`);
    // Bind ch but NOT pi — simulates the backfilled post-event-reprocess case.
    await bindPagamentoToCh(rig, idPagamento, chId);
    // Plan 0015 Phase 3: see (g) above — mark aprovado for the link-only
    // assertion path.
    await markPagamentoAprovado(rig, idPagamento);

    const event = makeStripeEvent('charge.succeeded', {
      id: chId,
      payment_intent: piIdUnknown, // doesn't match anything
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(idPagamento);
  });

  // ───── (i) ordering edge case — pi before cs ──────────────────────

  it('(i) payment_intent.succeeded arriving BEFORE checkout.session.completed: archived as orphan, no error', async () => {
    // No pagamento is bound to this pi (because cs.completed hasn't fired).
    const event = makeStripeEvent('payment_intent.succeeded', {
      id: `pi_test_orphan_${randomUUID()}`,
      latest_charge: `ch_test_${randomUUID()}`,
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull(); // orphan — handler exits cleanly
  });

  it('(i-2) charge.succeeded arriving with no resolvable pi or ch refs: archived as orphan', async () => {
    const event = makeStripeEvent('charge.succeeded', {
      id: `ch_test_orphan_${randomUUID()}`,
      payment_intent: `pi_test_unknown_${randomUUID()}`,
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull();
  });

  // ───── (j) Unknown event type ─────────────────────────────────────

  it('(j) unknown event type: archived but NOT linked, no error', async () => {
    const event = makeStripeEvent('invoice.payment_succeeded', {
      id: 'inv_test_123',
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull();
  });

  // ───── side-effect idempotency: cs.completed re-run preserves pi ──

  it('cs.completed re-fired with the same pi: idempotent — update is a no-op (early return on === check)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const { idPagamento, idContribuicao } = await seedPagamentoWithSession(rig, sessionId);

    // Minimal contribuicao + campanha seeding for finalize to not blow up.
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
      valor: 4725 as never,
      status: 'disponivel',
      imagemUrl: null,
      grupo: null,
      criadaEm: new Date(),
      contribuinteNome: null,
      contribuinteEmail: null,
    } as never);

    const event = makeStripeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: piId,
    });

    // First fire: persists pi.
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    const afterFirst = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(afterFirst?.intencao.paymentIntentExternalRef).toBe(piId);

    // Second fire (Stripe replay during dev): pi still equals; update
    // path is gated by !== check so we don't churn the row pointlessly.
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    const afterSecond = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(afterSecond?.intencao.paymentIntentExternalRef).toBe(piId);
  });
});
