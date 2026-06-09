/**
 * Plan 0015 Phase 3 (aperture-ndxuf). Dispatcher tests for the 12-event
 * Stripe → FSM mapping table. Exercises dispatchVerifiedStripeEvent
 * against in-memory adapters; pipeline signature math is out of scope
 * (covered by aperture-1n6u8's stripe-webhook-pipeline.test.ts).
 *
 * The test cases ladder through every row in the dispatch table from
 * the webhook handler's header docblock — including the NO-TRANSITION
 * rows (partial refund stays aprovado, dispute audit-only, etc.)
 * which are the easiest to miss.
 *
 * Adapters used:
 *   - PagamentoRepositoryMemory + LivroFinanceiroRepositoryMemory
 *     (in-memory, no DB)
 *   - PagamentoProviderFake (refund/aprovar flows; configurable
 *     refund status for the recusado path)
 *   - PagamentoEventPublisherMemory (no-op for these tests)
 *
 * Built and shipped in chunks (per GLaDOS's recovery strategy after
 * two socket drops on the original single-Write attempt).
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
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
  provider: PagamentoProviderFake;
}

function buildRig(overrides?: {
  refundStatus?: 'aceito' | 'recusado';
  /**
   * Controls what PagamentoProviderFake.solicitarPagamento returns.
   * Use 'rejeitado' for tests that exercise the rejection flow —
   * `rejeitarPagamento` validates `transacao.status === 'rejeitado'`
   * and throws otherwise. Default 'aprovado' matches the fake's own
   * default and works for happy-path tests.
   */
  solicitarStatus?: 'aprovado' | 'rejeitado';
}): TestRig {
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
  const provider = new PagamentoProviderFake({
    statusRefund: overrides?.refundStatus ?? 'aceito',
    statusResultado: overrides?.solicitarStatus ?? 'aprovado',
  });

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
    clock: () => new Date('2026-06-03T12:00:00.000Z'),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaa',
    // aperture-v4ax3: cs.completed sweeps orphans via the archive.
    webhookEventArchive: new WebhookEventArchiveMemory(),
  } as unknown as ServerDeps;

  return { deps, pagamentoRepository, livroFinanceiroRepository, provider };
}

interface SeededIds {
  idPagamento: string;
  idContribuicao: string;
  idCampanha: string;
  idOpcao: string;
  idPlataforma: string;
}

/**
 * Seed a pendente pagamento bound to a Stripe session id, AND seed
 * the upstream contribuicao + campanha so finalize-aprovado has the
 * entities it needs for its cross-BC reads.
 */
async function seedFullChain(
  rig: TestRig,
  sessionId: string,
  metodo: 'pix' | 'credit_card' = 'credit_card',
): Promise<SeededIds> {
  const ids: SeededIds = {
    idPagamento: randomUUID(),
    idContribuicao: randomUUID(),
    idCampanha: randomUUID(),
    idOpcao: randomUUID(),
    idPlataforma: randomUUID(),
  };

  await rig.deps.campanhaRepository.save({
    id: ids.idCampanha as never,
    idPlataforma: ids.idPlataforma as never,
    idsAdministradores: [],
    titulo: 't',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

  await rig.deps.contribuicaoRepository.save({
    id: ids.idContribuicao as never,
    idCampanha: ids.idCampanha as never,
    idOpcaoContribuicao: ids.idOpcao as never,
    nome: 't',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  } as never);

  const pagamento = makePagamento({
    id: ids.idPagamento,
    idContribuicao: ids.idContribuicao,
    idCampanha: ids.idCampanha,
    metodo,
    contributionUnitAmountCents: 4500,
    feeUnitAmountCents: 225,
    surchargeCents: metodo === 'credit_card' ? 224 : 0,
    valorACobrarCents: metodo === 'credit_card' ? 4949 : 4725,
    externalRef: sessionId,
    criadoEm: new Date('2026-06-03T12:00:00.000Z'),
  });
  await rig.pagamentoRepository.save(pagamento);

  return ids;
}

/** Patch a pagamento's status directly (test-shortcut for terminal-state cases). */
async function setStatus(
  rig: TestRig,
  idPagamento: string,
  status: 'pendente' | 'processing' | 'aprovado' | 'rejeitado' | 'estornado',
): Promise<void> {
  const p = await rig.pagamentoRepository.findById(idPagamento as never);
  if (!p) throw new Error('pagamento not seeded');
  await rig.pagamentoRepository.update({ ...p, status: status as never });
}

/** Patch a pagamento's pi/ch external refs (simulates prior webhook events). */
async function setRefs(
  rig: TestRig,
  idPagamento: string,
  refs: { pi?: string; ch?: string },
): Promise<void> {
  const p = await rig.pagamentoRepository.findById(idPagamento as never);
  if (!p) throw new Error('pagamento not seeded');
  await rig.pagamentoRepository.update({
    ...p,
    intencao: {
      ...p.intencao,
      ...(refs.pi !== undefined ? { paymentIntentExternalRef: refs.pi } : {}),
      ...(refs.ch !== undefined ? { chargeExternalRef: refs.ch } : {}),
    },
  });
}

/** Seed lancamentos for the pagamento (used by the estorno + refund tests). */
async function seedLancamentos(
  rig: TestRig,
  ids: SeededIds,
  options?: { recebedorTransferido?: boolean },
): Promise<void> {
  await rig.livroFinanceiroRepository.saveLancamentos([
    {
      id: randomUUID() as never,
      idPagamento: ids.idPagamento as never,
      idContribuicao: ids.idContribuicao as never,
      idCampanha: ids.idCampanha as never,
      tipo: 'credito_saldo_recebedor',
      amountCents: 4500,
      criadoEm: new Date('2026-06-03T12:00:00.000Z'),
      transferidoEm: options?.recebedorTransferido ? new Date('2026-06-03T13:00:00.000Z') : null,
      canceladoEm: null,
    } as never,
    {
      id: randomUUID() as never,
      idPagamento: ids.idPagamento as never,
      idContribuicao: ids.idContribuicao as never,
      tipo: 'credito_receita_plataforma',
      amountCents: 225,
      criadoEm: new Date('2026-06-03T12:00:00.000Z'),
      transferidoEm: null,
      canceladoEm: null,
    } as never,
  ]);
}

/** Build a minimal Stripe.Event payload — only the fields the dispatcher reads. */
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

// ────────────────────────────────────────────────────────────────────
//  CHUNK A — checkout.session.completed (card immediate + pix pending)
// ────────────────────────────────────────────────────────────────────

describe('Phase 3 dispatcher: checkout.session.completed', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('card immediate (payment_status=paid): pendente → aprovado + contribuinte stamped + pi persisted', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'credit_card');

    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: piId,
      payment_status: 'paid',
      customer_details: { email: 'visitor@example.com' },
      custom_fields: [
        { key: 'nome', text: { value: 'Visitante Cartao' } },
        { key: 'mensagem', text: { value: 'Parabens!' } },
      ],
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado');
    expect(updated?.intencao.paymentIntentExternalRef).toBe(piId);
    expect(updated?.intencao.contribuinte?.nome).toBe('Visitante Cartao');
    expect(updated?.intencao.contribuinte?.email).toBe('visitor@example.com');
    expect(updated?.intencao.contribuinte?.mensagem).toBe('Parabens!');
  });

  it('pix pending (payment_status=processing): pendente → processing + contribuinte stamped (no finalize yet)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');

    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: piId,
      payment_status: 'processing',
      customer_details: { email: 'pix-visitor@example.com' },
      custom_fields: [{ key: 'nome', text: { value: 'Visitante Pix' } }],
    });

    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('processing');
    expect(updated?.intencao.paymentIntentExternalRef).toBe(piId);
    expect(updated?.intencao.contribuinte?.nome).toBe('Visitante Pix');
    expect(updated?.intencao.contribuinte?.email).toBe('pix-visitor@example.com');
    // No lancamentos yet — finalize fires later via charge.succeeded.
    const lancs = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(
      ids.idPagamento as never,
    );
    expect(lancs).toHaveLength(0);
  });

  it('unknown session: no-op + null pagamentoId', async () => {
    const event = makeEvent('checkout.session.completed', {
      id: `cs_test_unknown_${randomUUID()}`,
      payment_intent: 'pi_test_x',
      payment_status: 'paid',
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull();
  });

  it('payment_status=unpaid (rare on completed): no-op transition, audit only', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);

    const event = makeEvent('checkout.session.completed', {
      id: sessionId,
      payment_intent: 'pi_test_x',
      payment_status: 'unpaid',
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('pendente'); // unchanged
  });
});

// ────────────────────────────────────────────────────────────────────
//  CHUNK B — checkout.session.expired + payment_intent.*
// ────────────────────────────────────────────────────────────────────

describe('Phase 3 dispatcher: checkout.session.expired', () => {
  let rig: TestRig;
  beforeEach(() => {
    // Rejection flow: provider must return rejeitado.
    rig = buildRig({ solicitarStatus: 'rejeitado' });
  });

  it('pendente → rejeitado', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);

    const event = makeEvent('checkout.session.expired', { id: sessionId });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('rejeitado');
  });

  it('unknown session: null pagamentoId', async () => {
    const event = makeEvent('checkout.session.expired', {
      id: `cs_test_unknown_${randomUUID()}`,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull();
  });
});

describe('Phase 3 dispatcher: payment_intent.processing', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('pendente → processing (pix QR scanned)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });

    const event = makeEvent('payment_intent.processing', { id: piId });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('processing');
  });

  it('idempotent on processing → processing (no-op skip)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'processing');

    const event = makeEvent('payment_intent.processing', { id: piId });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('processing'); // still
  });

  it('no-op on aprovado (terminal): dispatcher skips, status unchanged', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('payment_intent.processing', { id: piId });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // unchanged
  });
});

describe('Phase 3 dispatcher: payment_intent.payment_failed', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig({ solicitarStatus: 'rejeitado' });
  });

  it('processing → rejeitado (pix failure mid-flight, resolves via pi)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'processing');

    const event = makeEvent('payment_intent.payment_failed', { id: piId });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('rejeitado');
  });

  it('legacy fallback via metadata.idPagamento when pi lookup misses', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piIdUnknown = `pi_unknown_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    // Note: NOT calling setRefs — pi link is missing on purpose.

    const event = makeEvent('payment_intent.payment_failed', {
      id: piIdUnknown,
      metadata: { idPagamento: ids.idPagamento },
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('rejeitado');
  });
});

// ────────────────────────────────────────────────────────────────────
//  CHUNK C — charge.{succeeded, failed, updated}
// ────────────────────────────────────────────────────────────────────

describe('Phase 3 dispatcher: charge.succeeded', () => {
  let rig: TestRig;
  beforeEach(() => {
    // Happy path → provider returns aprovado (default).
    rig = buildRig();
  });

  it('pendente → aprovado (card path, charge resolves via pi)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'credit_card');
    await setRefs(rig, ids.idPagamento, { pi: piId });

    const event = makeEvent('charge.succeeded', {
      id: chId,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado');
  });

  it('processing → aprovado (pix path: cs already promoted to processing, charge confirms)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'processing');

    const event = makeEvent('charge.succeeded', {
      id: chId,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado');
  });

  it('terminal skip on aprovado: returns pagamentoId, no re-transition', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('charge.succeeded', {
      id: `ch_test_${randomUUID()}`,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado');
  });

  it('terminal skip on estornado', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'estornado');

    const event = makeEvent('charge.succeeded', {
      id: `ch_test_${randomUUID()}`,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('estornado');
  });
});

describe('Phase 3 dispatcher: charge.failed', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig({ solicitarStatus: 'rejeitado' });
  });

  it('processing → rejeitado (resolves via pi)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId, 'pix');
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'processing');

    const event = makeEvent('charge.failed', {
      id: chId,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('rejeitado');
  });

  it('terminal skip on aprovado (Stripe reports charge.failed AFTER a separate charge succeeded — rare ordering)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('charge.failed', {
      id: `ch_test_${randomUUID()}`,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // unchanged
  });
});

describe('Phase 3 dispatcher: charge.updated (audit only, no transition)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('links pagamento but does NOT transition', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('charge.updated', {
      id: chId,
      payment_intent: piId,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // unchanged
  });
});

// ────────────────────────────────────────────────────────────────────
//  CHUNK D — charge.refunded (full + partial) + charge.dispute.created
// ────────────────────────────────────────────────────────────────────

describe('Phase 3 dispatcher: charge.refunded — FULL', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig(); // refund status = aceito (default)
  });

  it('aprovado → estornado + cascades canceladoEm on lançamentos', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId, ch: chId });
    await setStatus(rig, ids.idPagamento, 'aprovado');
    await seedLancamentos(rig, ids);

    const event = makeEvent('charge.refunded', {
      id: chId,
      payment_intent: piId,
      amount: 4949,
      amount_refunded: 4949, // FULL
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('estornado');

    // All untransferred lançamentos cancelled.
    const lancs = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(
      ids.idPagamento as never,
    );
    for (const l of lancs) {
      expect(l.canceladoEm).not.toBeNull();
    }
  });

  it('idempotent on already-estornado (skip + audit)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId, ch: chId });
    await setStatus(rig, ids.idPagamento, 'estornado');

    const event = makeEvent('charge.refunded', {
      id: chId,
      payment_intent: piId,
      amount: 4949,
      amount_refunded: 4949,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('estornado'); // unchanged
  });

  it('state-drift signal: 409 from estornar use-case bubbles up as a thrown error (Stripe will retry; operator investigates)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId, ch: chId });
    await setStatus(rig, ids.idPagamento, 'aprovado');
    // Lancamentos with the recebedor row ALREADY transferred — the
    // estornar use-case's 409 gate fires.
    await seedLancamentos(rig, ids, { recebedorTransferido: true });

    const event = makeEvent('charge.refunded', {
      id: chId,
      payment_intent: piId,
      amount: 4949,
      amount_refunded: 4949,
    });
    await expect(dispatchVerifiedStripeEvent(rig.deps, noopSpan, event)).rejects.toThrow(
      /Estorno bloqueado/,
    );

    // Pagamento stays aprovado (no partial transition).
    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado');
  });
});

describe('Phase 3 dispatcher: charge.refunded — PARTIAL (no transition)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('amount_refunded < amount: stays aprovado, no cancel cascade', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId, ch: chId });
    await setStatus(rig, ids.idPagamento, 'aprovado');
    await seedLancamentos(rig, ids);

    const event = makeEvent('charge.refunded', {
      id: chId,
      payment_intent: piId,
      amount: 4949,
      amount_refunded: 2000, // PARTIAL
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // locked decision #7

    const lancs = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(
      ids.idPagamento as never,
    );
    for (const l of lancs) {
      expect(l.canceladoEm).toBeNull();
    }
  });

  it('amount=0 or amount_refunded=0: treats as partial (defensive — no transition)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const piId = `pi_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { pi: piId, ch: chId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('charge.refunded', {
      id: chId,
      payment_intent: piId,
      amount: 0,
      amount_refunded: 0,
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // unchanged
  });
});

describe('Phase 3 dispatcher: charge.dispute.created (out-of-scope; audit only)', () => {
  let rig: TestRig;
  beforeEach(() => {
    rig = buildRig();
  });

  it('links pagamento via charge id but does NOT transition (stays aprovado)', async () => {
    const sessionId = `cs_test_${randomUUID()}`;
    const chId = `ch_test_${randomUUID()}`;
    const ids = await seedFullChain(rig, sessionId);
    await setRefs(rig, ids.idPagamento, { ch: chId });
    await setStatus(rig, ids.idPagamento, 'aprovado');

    const event = makeEvent('charge.dispute.created', {
      id: `dp_test_${randomUUID()}`,
      charge: chId,
      amount: 4949,
      reason: 'fraudulent',
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBe(ids.idPagamento);

    const updated = await rig.pagamentoRepository.findById(ids.idPagamento as never);
    expect(updated?.status).toBe('aprovado'); // out-of-scope, no transition
  });

  it('unknown charge: null pagamentoId, no error', async () => {
    const event = makeEvent('charge.dispute.created', {
      id: `dp_test_${randomUUID()}`,
      charge: `ch_unknown_${randomUUID()}`,
      amount: 4949,
      reason: 'fraudulent',
    });
    const result = await dispatchVerifiedStripeEvent(rig.deps, noopSpan, event);
    expect(result.pagamentoId).toBeNull();
  });
});
