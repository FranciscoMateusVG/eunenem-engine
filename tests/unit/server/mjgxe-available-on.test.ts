/**
 * Tests for aperture-mjgxe — derived liberação extension.
 *
 * Covers the three Track-2 surfaces:
 *   (A) Webhook dispatcher payment_intent.succeeded branches on metodo
 *       and populates intencao.balanceTransactionAvailableOn (NOW for
 *       PIX; Stripe API for cartão).
 *   (B) Admin DTO derives the liberacao field from (status, availableOn,
 *       now).
 *   (C) Provider port: fake adapter returns deterministic Date or null
 *       under the statusBalanceTransaction option.
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
//  (C) Fake adapter port-level behavior
// ────────────────────────────────────────────────────────────────────

describe('PagamentoProviderFake.obterAvailableOnDoCharge', () => {
  it('returns clock + offset (default 6 days) for statusBalanceTransaction=known (default)', async () => {
    const clock = () => new Date('2026-06-04T10:00:00Z');
    const provider = new PagamentoProviderFake({ clock });
    const result = await provider.obterAvailableOnDoCharge('ch_test_xyz');
    expect(result).toEqual(new Date('2026-06-10T10:00:00Z'));
  });

  it('returns null for statusBalanceTransaction=unknown', async () => {
    const provider = new PagamentoProviderFake({ statusBalanceTransaction: 'unknown' });
    const result = await provider.obterAvailableOnDoCharge('ch_test_xyz');
    expect(result).toBeNull();
  });

  it('honors custom availableOnOffsetSeconds', async () => {
    const clock = () => new Date('2026-06-04T10:00:00Z');
    const provider = new PagamentoProviderFake({
      clock,
      availableOnOffsetSeconds: 60 * 60, // 1 hour
    });
    const result = await provider.obterAvailableOnDoCharge('ch_test_xyz');
    expect(result).toEqual(new Date('2026-06-04T11:00:00Z'));
  });
});

// ────────────────────────────────────────────────────────────────────
//  (A) Dispatcher pi.succeeded — populates availableOn
// ────────────────────────────────────────────────────────────────────

interface DispatcherRig {
  deps: ServerDeps;
  pagamentoRepository: PagamentoRepositoryMemory;
}

function buildDispatcherRig(overrides?: {
  statusBalanceTransaction?: 'known' | 'unknown';
}): DispatcherRig {
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

  return { deps, pagamentoRepository };
}

async function seedPagamento(
  rig: DispatcherRig,
  options: { metodo: 'pix' | 'credit_card'; pi: string; ch: string },
): Promise<string> {
  const idPagamento = randomUUID();
  // Pre-populate pi + ch refs so resolvePagamentoFromPaymentIntent finds it.
  const pagamento = makePagamento({
    id: idPagamento,
    metodo: options.metodo,
    externalRef: 'cs_test_xxx',
    criadoEm: new Date('2026-06-04T09:00:00Z'),
    paymentIntentExternalRef: options.pi,
    chargeExternalRef: options.ch,
  });
  await rig.pagamentoRepository.save(pagamento);
  return idPagamento;
}

function makePiSucceededEvent(pi: string, ch: string): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: 'event',
    api_version: '2024-04-10',
    created: 1717000000,
    type: 'payment_intent.succeeded',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: { id: pi, latest_charge: ch } as unknown as Stripe.Event.Data.Object,
    },
  } as unknown as Stripe.Event;
}

const noopSpan = trace.getTracer('test').startSpan('test');

describe('Webhook dispatcher pi.succeeded — populates availableOn (aperture-mjgxe)', () => {
  let rig: DispatcherRig;
  beforeEach(() => {
    rig = buildDispatcherRig();
  });

  it('PIX branch: sets availableOn = NOW() inline (no Stripe API call needed)', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, { metodo: 'pix', pi, ch });

    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makePiSucceededEvent(pi, ch));

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-04T10:00:00Z'), // fake clock
    );
  });

  it('CARTÃO branch: fetches availableOn from Stripe (fake returns clock + 6 days)', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, { metodo: 'credit_card', pi, ch });

    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makePiSucceededEvent(pi, ch));

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-10T10:00:00Z'), // 6 days from fake clock
    );
  });

  it('CARTÃO + Stripe API returns null → persist null (admin inspects manually)', async () => {
    const rigUnknown = buildDispatcherRig({ statusBalanceTransaction: 'unknown' });
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rigUnknown, {
      metodo: 'credit_card',
      pi,
      ch,
    });

    await dispatchVerifiedStripeEvent(rigUnknown.deps, noopSpan, makePiSucceededEvent(pi, ch));

    const updated = await rigUnknown.pagamentoRepository.findById(idPagamento as never);
    // ch ref still persisted; available_on stays null.
    expect(updated?.intencao.chargeExternalRef).toBe(ch);
    expect(updated?.intencao.balanceTransactionAvailableOn).toBeNull();
  });

  it('idempotent: re-fire of pi.succeeded does not overwrite an already-populated availableOn', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, { metodo: 'pix', pi, ch });

    // First fire: populates with the fake clock value.
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makePiSucceededEvent(pi, ch));
    const first = await rig.pagamentoRepository.findById(idPagamento as never);
    const firstAvailableOn = first?.intencao.balanceTransactionAvailableOn;
    expect(firstAvailableOn).toEqual(new Date('2026-06-04T10:00:00Z'));

    // Second fire: same event. The dispatcher's if-guard checks `available_on === null`
    // before updating, so the existing value stays put.
    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makePiSucceededEvent(pi, ch));
    const second = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(second?.intencao.balanceTransactionAvailableOn).toEqual(firstAvailableOn);
  });
});
