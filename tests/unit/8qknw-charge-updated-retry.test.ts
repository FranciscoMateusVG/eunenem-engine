/**
 * Tests for aperture-8qknw — charge.updated retry of available_on
 * resolution.
 *
 * SYMPTOM: operator's cartão d674cc80 at 15:16:57Z hit the cs.completed
 * available_on path (1ewwh fix) correctly, but Stripe API returned null
 * because the balance_transaction wasn't yet fully populated. ~1-2s
 * later Stripe fires charge.updated with the field settled.
 *
 * FIX: charge.updated handler now retries the available_on resolution
 * when metodo='credit_card' AND pagamento.balanceTransactionAvailableOn
 * is still null. Idempotent — re-firing after a non-null persist is a
 * no-op (predicate short-circuits).
 *
 * Tests cover:
 *   (A) cartão + availableOn null + Stripe API returns valid date →
 *       PERSISTS via the cu_ path (the bug fix)
 *   (B) cartão + availableOn already populated → no Stripe call, no
 *       write (idempotency)
 *   (C) cartão + availableOn null + Stripe API still returns null →
 *       no-op (logged + persisted null + no crash)
 *   (D) PIX never goes through this path (was set inline at cs.completed)
 *   (E) chargeExternalRef backfill when missing
 */

import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { dispatchVerifiedStripeEvent } from '../../apps/eunenem-server/server/webhooks/stripe-webhook.ts';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { criarPagamentoPendente } from '../../src/domain/pagamentos/entities/pagamento.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';

const FAKE_NOW = new Date('2026-06-04T10:00:00Z');

interface TestRig {
  deps: ServerDeps;
  pagamentoRepository: PagamentoRepositoryMemory;
  provider: PagamentoProviderFake;
}

function buildRig(overrides?: {
  statusBalanceTransaction?: 'known' | 'unknown';
}): TestRig {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const provider = new PagamentoProviderFake({
    statusBalanceTransaction: overrides?.statusBalanceTransaction ?? 'known',
    clock: () => FAKE_NOW,
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
    clock: () => FAKE_NOW,
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive: archive,
  } as unknown as ServerDeps;

  return { deps, pagamentoRepository, provider };
}

async function seedPagamento(
  rig: TestRig,
  options: {
    metodo: 'pix' | 'credit_card';
    piId: string;
    chId: string | null;
    availableOn: Date | null;
  },
): Promise<string> {
  const idPagamento = randomUUID();
  const pagamento = criarPagamentoPendente({
    idPagamento: idPagamento as never,
    idIntencaoPagamento: randomUUID() as never,
    composicaoValores: {
      idContribuicao: randomUUID(),
      contributionAmountCents: 4500,
      feeAmountCents: 0,
      surchargeCents: 0,
      totalPaidCents: 4500,
      receiverAmountCents: 4500,
      responsavelTaxa: 'contribuinte',
    } as never,
    valorACobrarCents: 4500 as never,
    metodo: options.metodo,
    externalRef: 'cs_test_xxx',
    criadoEm: new Date('2026-06-04T09:00:00Z'),
  });
  await rig.pagamentoRepository.save({
    ...pagamento,
    intencao: {
      ...pagamento.intencao,
      paymentIntentExternalRef: options.piId,
      chargeExternalRef: options.chId,
      balanceTransactionAvailableOn: options.availableOn,
    },
  });
  return idPagamento;
}

function makeChargeUpdatedEvent(chId: string, piId: string): Stripe.Event {
  return {
    id: `evt_${randomUUID()}`,
    object: 'event',
    api_version: '2024-04-10',
    created: 1717000000,
    type: 'charge.updated',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: chId,
        payment_intent: piId,
      } as unknown as Stripe.Event.Data.Object,
    },
  } as unknown as Stripe.Event;
}

const noopSpan = trace.getTracer('test').startSpan('test');

describe('charge.updated retry — available_on resolution (aperture-8qknw)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('CARTÃO + availableOn null → fetches from Stripe and persists (the fix)', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, {
      metodo: 'credit_card',
      piId: pi,
      chId: ch,
      availableOn: null, // cs.completed returned null (the race condition)
    });

    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makeChargeUpdatedEvent(ch, pi));

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-10T10:00:00Z'), // fake +6 days
    );
  });

  it('CARTÃO + availableOn already populated → skips Stripe call (idempotency)', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const existingDate = new Date('2026-05-30T08:00:00Z');
    const idPagamento = await seedPagamento(rig, {
      metodo: 'credit_card',
      piId: pi,
      chId: ch,
      availableOn: existingDate,
    });

    const spy = vi.spyOn(rig.provider, 'obterAvailableOnDoCharge');

    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makeChargeUpdatedEvent(ch, pi));

    // The provider's obterAvailableOnDoCharge must NOT have been called.
    expect(spy).not.toHaveBeenCalled();

    // And the existing value stays untouched.
    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(existingDate);
  });

  it('CARTÃO + Stripe API still returns null → no-op persist (logged + no crash)', async () => {
    const rigUnknown = buildRig({ statusBalanceTransaction: 'unknown' });
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    const idPagamento = await seedPagamento(rigUnknown, {
      metodo: 'credit_card',
      piId: pi,
      chId: ch,
      availableOn: null,
    });

    await dispatchVerifiedStripeEvent(rigUnknown.deps, noopSpan, makeChargeUpdatedEvent(ch, pi));

    const updated = await rigUnknown.pagamentoRepository.findById(idPagamento as never);
    // Still null — next charge.updated event will retry. Operator-side
    // alerted via the cu_available_on_unknown log.
    expect(updated?.intencao.balanceTransactionAvailableOn).toBeNull();
  });

  it('PIX is unaffected — charge.updated never touches availableOn for PIX', async () => {
    const pi = `pi_test_${randomUUID()}`;
    const ch = `ch_test_${randomUUID()}`;
    // PIX availableOn was set inline at cs.completed.
    const inlineDate = new Date('2026-06-04T10:00:00Z');
    const idPagamento = await seedPagamento(rig, {
      metodo: 'pix',
      piId: pi,
      chId: ch,
      availableOn: inlineDate,
    });

    const spy = vi.spyOn(rig.provider, 'obterAvailableOnDoCharge');

    await dispatchVerifiedStripeEvent(rig.deps, noopSpan, makeChargeUpdatedEvent(ch, pi));

    expect(spy).not.toHaveBeenCalled();
    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(inlineDate);
  });

  it('CARTÃO + chargeExternalRef was missing → backfilled from charge.updated event payload', async () => {
    // Edge case: cs.completed handler didn't persist chargeRef (rare —
    // e.g. cs.completed payload's payment_intent didn't expand into
    // latest_charge cleanly). charge.updated has the charge.id directly,
    // so use it + persist alongside availableOn.
    const pi = `pi_test_${randomUUID()}`;
    const chFromEvent = `ch_event_${randomUUID()}`;
    const idPagamento = await seedPagamento(rig, {
      metodo: 'credit_card',
      piId: pi,
      chId: null, // missing on the pagamento
      availableOn: null,
    });

    await dispatchVerifiedStripeEvent(
      rig.deps,
      noopSpan,
      makeChargeUpdatedEvent(chFromEvent, pi),
    );

    const updated = await rig.pagamentoRepository.findById(idPagamento as never);
    expect(updated?.intencao.chargeExternalRef).toBe(chFromEvent);
    expect(updated?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-06-10T10:00:00Z'),
    );
  });
});
