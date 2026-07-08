/**
 * Integration tests for the admin.webhooks tRPC namespace (aperture-2sp6m).
 *
 * Lives in tests/unit/ because the test harness is fully in-memory
 * (no Postgres). The tRPC layer + tenant-guard chain + DTO projection
 * are exercised end-to-end via `appRouter.createCaller(ctx)`. Postgres
 * adapter conformance is verified separately by
 * `tests/integration/webhook-event-archive.postgres.test.ts`.
 *
 * Covers the 6 procedure-level acceptance criteria from the bead:
 *   (f) listByPagamento returns lean DTO array (no rawPayload field)
 *   (g) listByPagamento returns empty array (NOT 404) for a pagamento
 *       with zero archived events
 *   (h) getEventDetail returns full DTO with rawPayload + signatureHeader
 *   (i) Tenant guard: cross-plataforma pagamento → 403 on both procedures
 *   (j) getEventDetail on an orphan event id → 403
 *   (k) getEventDetail on a nonexistent event id → 404
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import type { Observability } from '../../../src/observability/observability.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';
import { makePagamento as makePagamentoBase } from '../../helpers/pagamento-repository.conformance.js';

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  deps: ServerDeps;
  pagamentoIdEunenem: string;
  pagamentoIdEucasei: string;
  observability: Observability;
}

// Minimal Pagamento aggregate matching the engine's shape. The webhook
// procedures resolve tenant via `pagamento.intencao.idCampanha` (Plan 0016
// Phase 4 / aperture-3htxg: cart-scope idCampanha hoisted to IntencaoPagamento
// root), so the fixture MUST thread idCampanha through to align the
// pagamento with the seeded campanha — otherwise `resolveAdminPagamentoContext`
// throws `dados_corrompidos: campanha_nao_encontrada` before the test gets
// to exercise the actual procedure surface.
function makePagamento(args: {
  id: string;
  idContribuicao: string;
  idCampanha: string;
}): Parameters<PagamentoRepositoryMemory['save']>[0] {
  // Plan 0016 Phase 2 (aperture-ktw11): delegate to the shared canonical
  // factory so the aggregate carries the new `items` + `composicaoValoresAggregate`
  // shape. Phase 4 admin tenant-guard reads idCampanha at the IntencaoPagamento
  // root — wire it through here so cross-tenant tests can assert FORBIDDEN
  // instead of falling through to campanha_nao_encontrada.
  return makePagamentoBase({
    id: args.id,
    idContribuicao: args.idContribuicao,
    idCampanha: args.idCampanha,
    status: 'aprovado',
    criadoEm: new Date('2026-06-02T10:00:00.000Z'),
  });
}

async function buildRig(): Promise<TestRig> {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const webhookEventArchive = new WebhookEventArchiveMemory();

  // Seed one Eunenem campanha + contribuicao + pagamento, one Eucasei
  // counterpart for the cross-tenant guard test.
  const idCampanhaEunenem = randomUUID();
  await campanhaRepository.save({
    id: idCampanhaEunenem as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    idsAdministradores: [],
    titulo: 'Test Eunenem',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

  const idCampanhaEucasei = randomUUID();
  await campanhaRepository.save({
    id: idCampanhaEucasei as never,
    idPlataforma: ID_PLATAFORMA_EUCASEI as never,
    idsAdministradores: [],
    titulo: 'Test Eucasei',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

  const idContribEunenem = randomUUID();
  const idContribEucasei = randomUUID();
  // Plan 0015 (aperture-ucgok): Contribuicao dropped `status` +
  // contribuinte fields. Slot is now a pure definition with no FSM.
  await contribuicaoRepository.save({
    id: idContribEunenem as never,
    idCampanha: idCampanhaEunenem as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: 'Test',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  } as never);
  await contribuicaoRepository.save({
    id: idContribEucasei as never,
    idCampanha: idCampanhaEucasei as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: 'Test Eucasei',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  } as never);

  const pagamentoIdEunenem = randomUUID();
  const pagamentoIdEucasei = randomUUID();
  await pagamentoRepository.save(
    makePagamento({
      id: pagamentoIdEunenem,
      idContribuicao: idContribEunenem,
      idCampanha: idCampanhaEunenem,
    }),
  );
  await pagamentoRepository.save(
    makePagamento({
      id: pagamentoIdEucasei,
      idContribuicao: idContribEucasei,
      idCampanha: idCampanhaEucasei,
    }),
  );

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
    pagamentoProvider: {} as never,
    checkoutSessionProvider: {} as never,
    pagamentoEventPublisher: {} as never,
    livroFinanceiroRepository: {} as never,
    provedorRegraTaxa: {} as never,
    observability,
    clock: () => new Date(),
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive,
  } as unknown as ServerDeps;

  const adminAuth = adminAuthOverrides();
  const ctx: TrpcContext = {
    deps: { ...deps, ...adminAuth.depsOverrides },
    headers: adminAuth.headers,
    resHeaders: new Headers(),
  };
  const caller = appRouter.createCaller(ctx);

  return {
    caller,
    deps,
    pagamentoIdEunenem,
    pagamentoIdEucasei,
    observability,
  };
}

async function expectTrpcError(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  const err = thrown as { code?: string; message?: string };
  expect(typeof err.code).toBe('string');
  return { code: err.code as string, message: err.message as string };
}

describe('admin.webhooks tRPC router (aperture-2sp6m)', () => {
  let rig: TestRig;

  beforeEach(async () => {
    rig = await buildRig();
  });

  // Avoid the suppress-output-when-running-concurrently helper here —
  // the tracer is noop already, so no spans leak between cases.
  afterEach(() => {});

  // ───── (f) listByPagamento — lean DTO array ────────────────────────

  it('(f) listByPagamento returns a lean DTO array (no rawPayload, no signatureHeader)', async () => {
    // Seed 2 events linked to the Eunenem pagamento.
    const ev1 = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'checkout.session.created',
      rawPayload: { id: 'sess_1' },
      signatureHeader: 't=ok,v1=abc',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(ev1.id, rig.pagamentoIdEunenem);
    const ev2 = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: { id: 'sess_2' },
      signatureHeader: 't=ok,v1=def',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(ev2.id, rig.pagamentoIdEunenem);

    const result = await rig.caller.admin.webhooks.listByPagamento({
      idPagamento: rig.pagamentoIdEunenem,
    });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.eventType)).toEqual([
      'checkout.session.created',
      'checkout.session.completed',
    ]);

    // Lean projection — these fields MUST NOT appear in the DTO.
    for (const e of result.events) {
      expect(e).not.toHaveProperty('rawPayload');
      expect(e).not.toHaveProperty('signatureHeader');
    }
    // Lean fields present.
    expect(result.events[0]).toMatchObject({
      provider: 'stripe',
      signatureValid: true,
      pagamentoId: rig.pagamentoIdEunenem,
    });
  });

  // ───── (g) listByPagamento empty array on no events ────────────────

  it('(g) listByPagamento returns empty array (not 404) when pagamento has no archived events', async () => {
    const result = await rig.caller.admin.webhooks.listByPagamento({
      idPagamento: rig.pagamentoIdEunenem,
    });
    expect(result.events).toEqual([]);
  });

  // ───── (h) getEventDetail — full DTO ────────────────────────────────

  it('(h) getEventDetail returns full DTO with rawPayload + signatureHeader', async () => {
    const seeded = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: { id: 'sess_full', amount_total: 4500, livemode: false },
      signatureHeader: 't=1717000000,v1=fullhash',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(seeded.id, rig.pagamentoIdEunenem);

    const result = await rig.caller.admin.webhooks.getEventDetail({
      idEvent: seeded.id,
    });

    expect(result.event.id).toBe(seeded.id);
    expect(result.event.eventType).toBe('checkout.session.completed');
    expect(result.event.signatureHeader).toBe('t=1717000000,v1=fullhash');
    expect(result.event.rawPayload).toEqual({
      id: 'sess_full',
      amount_total: 4500,
      livemode: false,
    });
    expect(result.event.pagamentoId).toBe(rig.pagamentoIdEunenem);
  });

  // ───── (i) Tenant guard — cross-plataforma → 403 ───────────────────

  it('(i) listByPagamento on a cross-plataforma pagamento throws FORBIDDEN', async () => {
    const err = await expectTrpcError(() =>
      rig.caller.admin.webhooks.listByPagamento({
        idPagamento: rig.pagamentoIdEucasei,
      }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('tenant_mismatch');
  });

  it('(i) getEventDetail on an event linked to a cross-plataforma pagamento throws FORBIDDEN', async () => {
    const seeded = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: {},
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(seeded.id, rig.pagamentoIdEucasei);

    const err = await expectTrpcError(() =>
      rig.caller.admin.webhooks.getEventDetail({ idEvent: seeded.id }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('tenant_mismatch');
  });

  it('(i) listByPagamento on a nonexistent pagamento throws NOT_FOUND', async () => {
    const err = await expectTrpcError(() =>
      rig.caller.admin.webhooks.listByPagamento({
        idPagamento: randomUUID(),
      }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('pagamento_nao_encontrado');
  });

  // ───── (j) getEventDetail on orphan → 403 ───────────────────────────

  it('(j) getEventDetail on an orphan event (pagamento_id NULL) throws FORBIDDEN', async () => {
    // Orphan: saveReceived without subsequent markProcessed.
    const orphan = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'invoice.created',
      rawPayload: {},
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    const err = await expectTrpcError(() =>
      rig.caller.admin.webhooks.getEventDetail({ idEvent: orphan.id }),
    );
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('evento_orfao_fora_do_escopo');
  });

  // ───── (k) getEventDetail on nonexistent event → 404 ────────────────

  it('(k) getEventDetail on a nonexistent event id throws NOT_FOUND', async () => {
    const err = await expectTrpcError(() =>
      rig.caller.admin.webhooks.getEventDetail({ idEvent: randomUUID() }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('evento_nao_encontrado');
  });

  // ───── Ordering verification (received_at ASC default) ──────────────

  it('listByPagamento returns events ordered received_at ASC (oldest first)', async () => {
    const ev1 = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_a_${randomUUID()}`,
      eventType: 'checkout.session.created',
      rawPayload: {},
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(ev1.id, rig.pagamentoIdEunenem);
    const ev2 = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_b_${randomUUID()}`,
      eventType: 'checkout.session.completed',
      rawPayload: {},
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(ev2.id, rig.pagamentoIdEunenem);
    const ev3 = await rig.deps.webhookEventArchive.saveReceived({
      provider: 'stripe',
      providerEventId: `evt_c_${randomUUID()}`,
      eventType: 'payment_intent.succeeded',
      rawPayload: {},
      signatureHeader: 't=ok',
      signatureValid: true,
    });
    await rig.deps.webhookEventArchive.markProcessed(ev3.id, rig.pagamentoIdEunenem);

    const result = await rig.caller.admin.webhooks.listByPagamento({
      idPagamento: rig.pagamentoIdEunenem,
    });
    expect(result.events.map((e) => e.id)).toEqual([ev1.id, ev2.id, ev3.id]);
  });
});
