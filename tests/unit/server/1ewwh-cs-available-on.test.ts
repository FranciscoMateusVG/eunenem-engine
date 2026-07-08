/**
 * Tests for aperture-1ewwh — cs.completed retroactive available_on
 * resolution (orphan path for cartão).
 *
 * SYMPTOM: operator's cartão walk found pagamentos with status='aprovado'
 * but balanceTransactionAvailableOn=null. Trace shows the order was
 *   1. payment_intent.succeeded arrives (BEFORE cs.completed)
 *   2. dispatcher branches into pi.succeeded handler, calls
 *      resolvePagamentoFromPaymentIntent() which lookups by the pi-ref
 *      column on pagamento — column is still null at this point because
 *      cs.completed (which persists pi-ref) hasn't fired yet
 *   3. lookup misses → handler bails on `unknown_payment_intent` and
 *      returns. balanceTransactionAvailableOn NEVER gets set.
 *   4. cs.completed arrives, persists pi-ref, relinks archive orphans
 *      (the aperture-v4ax3 sweep) — but does NOT re-fire the dispatcher
 *      for those events, so available_on stays null forever.
 *
 * FIX SHAPE (Option A): cs.completed handler now also resolves
 * balanceTransactionAvailableOn inline after persisting pi-ref. Branches
 * by metodo:
 *   - PIX: set to clock() inline (legacy no-cancel domain shortcut)
 *   - CARTÃO: call new port method obterAvailableOnDoPaymentIntent(piId)
 *     which fetches PI from Stripe with latest_charge.balance_transaction
 *     expanded; returns both chargeRef and availableOn in one call.
 *     Also persists chargeRef on the pagamento (the orphan case had it
 *     null too, since pi.succeeded's ch-ref persistence also bailed).
 *
 * IDEMPOTENCY: the inline resolution is gated on
 * `balanceTransactionAvailableOn === null` — already-populated values
 * (e.g. via a prior pi.succeeded that DID land) are preserved.
 *
 * Tests below exercise:
 *   (A) New port method on the fake adapter — chargeRef + availableOn
 *       returned per statusBalanceTransaction option.
 *   (B) cs.completed dispatcher — populates availableOn + chargeRef for
 *       the cartão orphan path (the bug); for pix; preserves an already-
 *       populated availableOn; handles the API-null fallback.
 */

import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type Stripe from 'stripe';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import { dispatchVerifiedStripeEvent } from '../../../apps/eunenem-server/server/webhooks/stripe-webhook.ts';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

// ────────────────────────────────────────────────────────────────────
//  (A) Fake adapter — new obterAvailableOnDoPaymentIntent port method
// ────────────────────────────────────────────────────────────────────

describe('PagamentoProviderFake.obterAvailableOnDoPaymentIntent', () => {
  it('returns chargeRef + clock+offset for statusBalanceTransaction=known (default)', async () => {
    const clock = () => new Date('2026-06-04T10:00:00Z');
    const provider = new PagamentoProviderFake({ clock });
    const result = await provider.obterAvailableOnDoPaymentIntent('pi_test_xyz');
    expect(result.chargeRef).toMatch(/^ch_fake_/);
    expect(result.availableOn).toEqual(new Date('2026-06-10T10:00:00Z'));
  });

  it('returns { chargeRef: null, availableOn: null } for statusBalanceTransaction=unknown', async () => {
    const provider = new PagamentoProviderFake({ statusBalanceTransaction: 'unknown' });
    const result = await provider.obterAvailableOnDoPaymentIntent('pi_test_xyz');
    expect(result.chargeRef).toBeNull();
    expect(result.availableOn).toBeNull();
  });

  it('honors custom availableOnOffsetSeconds', async () => {
    const clock = () => new Date('2026-06-04T10:00:00Z');
    const provider = new PagamentoProviderFake({
      clock,
      availableOnOffsetSeconds: 60 * 60, // 1 hour
    });
    const result = await provider.obterAvailableOnDoPaymentIntent('pi_test_xyz');
    expect(result.availableOn).toEqual(new Date('2026-06-04T11:00:00Z'));
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) Dispatcher cs.completed — populates availableOn (the bug fix)
// ────────────────────────────────────────────────────────────────────

interface TestRig {
  deps: ServerDeps;
  pagamentoRepository: PagamentoRepositoryMemory;
  archive: WebhookEventArchiveMemory;
}

function buildRig(overrides?: { statusBalanceTransaction?: 'known' | 'unknown' }): TestRig {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const fakeClock = () => new Date('2026-06-04T10:00:00Z');
  const provider = new PagamentoProviderFake({
    statusBalanceTransaction: overrides?.statusBalanceTransaction ?? 'known',
    clock: fakeClock,
  });
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
    clock: fakeClock,
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive: archive,
  } as unknown as ServerDeps;

  return { deps, pagamentoRepository, archive };
}

async function seedPagamento(
  rig: TestRig,
  options: {
    metodo: 'pix' | 'credit_card';
    sessionId: string;
    prePopulatedAvailableOn?: Date | null;
    prePopulatedChargeRef?: string | null;
  },
): Promise<string> {
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
    metodo: options.metodo,
    externalRef: options.sessionId,
    criadoEm: new Date('2026-06-04T09:00:00Z'),
    // Pre-populate fields per test scenario. By default both stay null —
    // that's the "orphan path" shape we're fixing.
    balanceTransactionAvailableOn:
      options.prePopulatedAvailableOn !== undefined ? options.prePopulatedAvailableOn : null,
    chargeExternalRef:
      options.prePopulatedChargeRef !== undefined ? options.prePopulatedChargeRef : null,
  });
  await rig.pagamentoRepository.save(pagamento);
  return idPagamento;
}

function makeCsCompletedEvent(
  sessionId: string,
  piId: string,
  paymentStatus: 'paid' | 'processing',
): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: 'event',
    api_version: '2024-04-10',
    created: 1717000000,
    type: 'checkout.session.completed',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: sessionId,
        payment_intent: piId,
        payment_status: paymentStatus,
        customer_details: { email: 'v@example.com' },
        custom_fields: [{ key: 'nome', text: { value: 'V' } }],
      } as unknown as Stripe.Event.Data.Object,
    },
  } as unknown as Stripe.Event;
}

const noopSpan = trace.getTracer('test').startSpan('test');

describe('cs.completed dispatcher — retroactive available_on (aperture-1ewwh)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('CARTÃO orphan path: populates BOTH chargeRef and availableOn when both were null', async () => {
    // This is the bug-fix test. The orphan scenario:
    //   1. pi.succeeded arrived FIRST, bailed on unknown_payment_intent
    //      (pagamento.intencao.paymentIntentExternalRef was null at that
    //      point), so neither chargeRef nor availableOn got set.
    //   2. cs.completed now arrives. It must do the resolution that
    //      pi.succeeded skipped.
    //
    // We use payment_status='processing' here even though real cartão
    // flows fire 'paid' — the available_on resolution runs BEFORE the
    // payment_status branch, so 'processing' exercises the same code
    // path without invoking finalizarPagamentoAprovado (which would
    // require more financeiro test rigging). FSM transition is covered
    // by phase3-dispatcher tests.
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, {
      metodo: 'credit_card',
      sessionId,
      // Both fields stay null — the orphan path.
    });

    await dispatchVerifiedStripeEvent(
      rig.deps,
      noopSpan,
      makeCsCompletedEvent(sessionId, pi, 'processing'),
    );

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.paymentIntentExternalRef).toBe(pi);
    expect(updated?.intencao.chargeExternalRef).toMatch(/^ch_fake_/);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-10T10:00:00Z'), // 6 days from fake clock
    );
  });

  it('PIX path: sets availableOn = clock() inline, no Stripe API call needed', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, {
      metodo: 'pix',
      sessionId,
    });

    await dispatchVerifiedStripeEvent(
      rig.deps,
      noopSpan,
      makeCsCompletedEvent(sessionId, pi, 'processing'),
    );

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-04T10:00:00Z'), // fake clock
    );
    // PIX doesn't touch chargeRef in cs.completed — that's still
    // populated later via pi.succeeded / charge.succeeded.
    expect(updated?.intencao.chargeExternalRef).toBeNull();
  });

  it('CARTÃO + Stripe API returns null → persist null (admin inspects Stripe manually)', async () => {
    const rigUnknown = buildRig({ statusBalanceTransaction: 'unknown' });
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rigUnknown, {
      metodo: 'credit_card',
      sessionId,
    });

    await dispatchVerifiedStripeEvent(
      rigUnknown.deps,
      noopSpan,
      makeCsCompletedEvent(sessionId, pi, 'processing'),
    );

    const updated = await rigUnknown.pagamentoRepository.findById(idPagamento as never);
    // pi ref persisted regardless (needed for downstream wif8s lookup).
    expect(updated?.intencao.paymentIntentExternalRef).toBe(pi);
    // available_on stays null — operator alerted via webhook.stripe.cs_available_on_unknown log.
    expect(updated?.intencao.balanceTransactionAvailableOn).toBeNull();
  });

  it('idempotency: pre-populated availableOn is NOT overwritten', async () => {
    // pi.succeeded already landed (e.g. for a non-orphan path) and set
    // availableOn to a real value. cs.completed firing after should NOT
    // clobber it with a fresh Stripe API call result.
    const sessionId = `cs_test_${randomUUID()}`;
    const pi = `pi_test_${randomUUID()}`;
    const existingAvailableOn = new Date('2026-05-30T08:00:00Z');
    const existingChargeRef = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, {
      metodo: 'credit_card',
      sessionId,
      prePopulatedAvailableOn: existingAvailableOn,
      prePopulatedChargeRef: existingChargeRef,
    });

    await dispatchVerifiedStripeEvent(
      rig.deps,
      noopSpan,
      makeCsCompletedEvent(sessionId, pi, 'processing'),
    );

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(existingAvailableOn);
    // chargeRef also preserved (the if-guard checks availableOn === null
    // before doing the Stripe call that would return a fresh ch).
    expect(updated?.intencao.chargeExternalRef).toBe(existingChargeRef);
  });
});
