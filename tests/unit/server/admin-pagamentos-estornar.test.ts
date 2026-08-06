/**
 * Tests for aperture-4uvgf — admin.pagamentos.estornar mutation +
 * admin.pagamentos.devolucaoStatus query.
 *
 * The mutation is a THIN WRAPPER over the estornarPagamento use-case
 * (src/use-cases/checkout/estornar-pagamento.ts) — provenance routing,
 * the 409 ledger gate, and status guards all live in the use-case. These
 * tests exercise the tRPC layer end-to-end through appRouter.createCaller:
 *
 *   1. Stripe-provenance aprovado → aceito / estornado / refundId
 *   2. Inter-provenance aprovado → em_processamento + persisted devolução
 *   3. 409 gate: transferred lançamento → CONFLICT lancamento_ja_transferido
 *   4. pendente pagamento → CONFLICT pagamento_status_invalido
 *   5. unknown idPagamento → NOT_FOUND pagamento_nao_encontrado
 *   6. RBAC: non-allowlisted caller → FORBIDDEN
 *   7. devolucaoStatus on Stripe provenance → { devolucao: null }
 *
 * Rig mirrors tests/unit/server/admin-repasses-router.test.ts (memory
 * adapters + adminAuthOverrides). Pagamento seeding mirrors
 * tests/unit/checkout/estornar-pagamento.test.ts (stripe) and
 * estornar-pagamento-inter.test.ts (inter).
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PixCobrancaDevolucaoRepositoryMemory } from '../../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.memory.js';
import { PixCobrancaProviderFake } from '../../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import {
  aprovarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

/**
 * Minimal campanha lookup for the tenant guard. Both endpoints now call
 * resolveAdminPagamentoContext, which reads campanhaRepository.findById to
 * check idPlataforma — so the rig must register each seeded pagamento's
 * campanha with a platform. Cross-platform tests register a foreign one.
 */
const campanhaPlataformaById = new Map<string, string>();
const fakeCampanhaRepository = {
  findById: async (idCampanha: string) => {
    const idPlataforma = campanhaPlataformaById.get(idCampanha);
    if (!idPlataforma) return undefined;
    // resolveAdminPagamentoContext reads .id + .idPlataforma only.
    return { id: idCampanha, idPlataforma } as never;
  },
} as never;

/**
 * The guard's contribuição fallback runs AFTER the platform check (which
 * FORBIDs cross-platform before reaching here), only on same-platform
 * payments. Callers of estornar/devolucaoStatus discard the returned
 * contribuição entirely — the guard just presence-checks it — so any
 * truthy shape satisfies the happy paths.
 */
const fakeContribuicaoRepository = {
  findById: async (id: string) => ({ id }) as never,
} as never;

const T0 = new Date('2026-08-05T12:00:00.000Z');
const T1 = new Date('2026-08-06T15:00:00.000Z');
const E2E_ID = 'E1234567890123456789012345678901';

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  pagamentoRepository: PagamentoRepositoryMemory;
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
  pixCobrancaProvider: PixCobrancaProviderFake;
  pixCobrancaDevolucaoRepository: PixCobrancaDevolucaoRepositoryMemory;
  /** Same deps, but the session email is NOT in the admin allowlist. */
  nonAdminCaller: ReturnType<typeof appRouter.createCaller>;
}

function buildRig(): TestRig {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const clock = () => T1;

  const pagamentoRepository = new PagamentoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();
  const pixCobrancaProvider = new PixCobrancaProviderFake();
  const pixCobrancaDevolucaoRepository = new PixCobrancaDevolucaoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake({ statusRefund: 'aceito' });
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();

  const deps = {
    db: {} as never,
    auth: {} as never,
    authService: {} as never,
    usuarioRepository: {} as never,
    plataformaRepository: {} as never,
    campanhaRepository: fakeCampanhaRepository,
    contribuicaoRepository: fakeContribuicaoRepository,
    recebedorRepository: {} as never,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: {} as never,
    pixCobrancaProvider,
    pixCobrancaDevolucaoRepository,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    repasseJobEnqueuer: {} as never,
    provedorRegraTaxa: {} as never,
    observability,
    clock,
    sessionCookieName: 'better-auth.session_token',
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive: {} as never,
  } as unknown as ServerDeps;

  const adminAuth = adminAuthOverrides();
  const ctx: TrpcContext = {
    deps: { ...deps, ...adminAuth.depsOverrides },
    headers: adminAuth.headers,
    resHeaders: new Headers(),
  };

  // Authenticated session whose email is NOT allowlisted → the gate's 403 path.
  const nonAdminAuth = adminAuthOverrides();
  const nonAdminCtx: TrpcContext = {
    deps: {
      ...deps,
      ...nonAdminAuth.depsOverrides,
      adminAllowedEmails: new Set(['someone-else@example.com']),
    },
    headers: nonAdminAuth.headers,
    resHeaders: new Headers(),
  };

  return {
    caller: appRouter.createCaller(ctx),
    pagamentoRepository,
    livroFinanceiroRepository,
    pixCobrancaProvider,
    pixCobrancaDevolucaoRepository,
    nonAdminCaller: appRouter.createCaller(nonAdminCtx),
  };
}

/**
 * Aprovado pagamento with Stripe provenance (transacaoExterna.provedor =
 * 'stripe' + chargeExternalRef) — mirrors seedAprovado in
 * tests/unit/checkout/estornar-pagamento.test.ts.
 */
async function seedAprovadoStripe(
  rig: TestRig,
  opts: { idPlataforma?: string } = {},
): Promise<Pagamento> {
  const id = randomUUID();
  const idCampanha = randomUUID();
  // Register the campanha's platform so the tenant guard resolves it.
  campanhaPlataformaById.set(idCampanha, opts.idPlataforma ?? ID_PLATAFORMA_EUNENEM);
  const pendente = makePagamento({
    id: id as never,
    idCampanha,
    idContribuicao: randomUUID() as never,
    criadoEm: T0,
    metodo: 'pix',
  });
  const aprovado = aprovarPagamentoPendente(
    pendente,
    {
      id: randomUUID(),
      provedor: 'stripe',
      status: 'aprovado',
      amountCents: pendente.intencao.composicaoValoresAggregate.totalPaidCents,
      criadaEm: T0,
    },
    T0,
  );
  const withCharge: Pagamento = {
    ...aprovado,
    intencao: { ...aprovado.intencao, chargeExternalRef: 'ch_test_fake_123' },
  };
  await rig.pagamentoRepository.save(withCharge);
  return withCharge;
}

/**
 * Aprovado pagamento with Banco Inter provenance — transacaoExterna binds
 * (id = e2eExternalRef, amountCents = totalPaidCents) exactly as in
 * tests/unit/checkout/estornar-pagamento-inter.test.ts, so the use-case's
 * bindingMatches gate passes.
 */
async function seedAprovadoInter(rig: TestRig): Promise<Pagamento> {
  const id = randomUUID();
  const idCampanha = randomUUID();
  campanhaPlataformaById.set(idCampanha, ID_PLATAFORMA_EUNENEM);
  const pendente = makePagamento({
    id: id as never,
    idCampanha,
    idContribuicao: randomUUID() as never,
    criadoEm: T0,
    metodo: 'pix',
  });
  const aprovado = aprovarPagamentoPendente(
    pendente,
    {
      id: E2E_ID,
      provedor: 'inter',
      status: 'aprovado',
      amountCents: pendente.intencao.composicaoValoresAggregate.totalPaidCents,
      criadaEm: T0,
    },
    T0,
  );
  const bound: Pagamento = {
    ...aprovado,
    intencao: { ...aprovado.intencao, e2eExternalRef: E2E_ID },
  };
  await rig.pagamentoRepository.save(bound);
  return bound;
}

async function seedLancamentoRecebedor(
  rig: TestRig,
  pagamento: Pagamento,
): Promise<LancamentoFinanceiro> {
  const lancamento: LancamentoFinanceiro = {
    id: randomUUID() as never,
    idPagamento: pagamento.id,
    idContribuicao: randomUUID() as never,
    idCampanha: pagamento.intencao.idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
  };
  await rig.livroFinanceiroRepository.saveLancamentos([lancamento]);
  return lancamento;
}

describe('admin.pagamentos.estornar (aperture-4uvgf)', () => {
  let rig: TestRig;
  beforeEach(() => {
    campanhaPlataformaById.clear();
    rig = buildRig();
  });

  it('refunds a Stripe-provenance aprovado pagamento synchronously (aceito → estornado)', async () => {
    const pagamento = await seedAprovadoStripe(rig);
    await seedLancamentoRecebedor(rig, pagamento);

    const result = await rig.caller.admin.pagamentos.estornar({
      idPagamento: pagamento.id,
      reason: 'requested_by_customer',
    });

    expect(result.refundStatus).toBe('aceito');
    expect(result.pagamentoStatus).toBe('estornado');
    expect(result.refundId).toMatch(/^re_fake_/);

    // Persisted: pagamento estornado, lançamento cancelled (not transferred).
    const persisted = await rig.pagamentoRepository.findById(pagamento.id);
    expect(persisted?.status).toBe('estornado');
    const lancamentos = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(
      pagamento.id,
    );
    expect(lancamentos[0]?.canceladoEm).toEqual(T1);
    expect(lancamentos[0]?.transferidoEm).toBeNull();
  });

  it('routes an Inter-provenance aprovado pagamento through the devolução flow (em_processamento) and persists the record', async () => {
    const pagamento = await seedAprovadoInter(rig);
    const idDevolucao = pagamento.id.replaceAll('-', '');

    const result = await rig.caller.admin.pagamentos.estornar({
      idPagamento: pagamento.id,
    });

    // PixCobrancaProviderFake's default solicitarDevolucao outcome is
    // em_processamento (async devolução — the webhook finalizes later), so
    // the pagamento stays aprovado and the refundId is the deterministic
    // dash-stripped pagamento id.
    expect(result.refundStatus).toBe('em_processamento');
    expect(result.pagamentoStatus).toBe('aprovado');
    expect(result.refundId).toBe(idDevolucao);
    expect(rig.pixCobrancaProvider.solicitarDevolucaoCalls).toBe(1);

    // The devolução record is persisted and readable via devolucaoStatus.
    const status = await rig.caller.admin.pagamentos.devolucaoStatus({
      idPagamento: pagamento.id,
    });
    expect(status.devolucao).not.toBeNull();
    expect(status.devolucao?.status).toBe('em_processamento');
    expect(status.devolucao?.idDevolucao).toBe(idDevolucao);
    expect(status.devolucao?.rtrId).toMatch(/^RTRFAKE/);
    expect(status.devolucao?.atualizadoEm).toBe(T1.toISOString());
  });

  it('maps the 409 ledger gate to CONFLICT lancamento_ja_transferido when a lançamento is already transferred', async () => {
    const pagamento = await seedAprovadoStripe(rig);
    const lancamento = await seedLancamentoRecebedor(rig, pagamento);
    await rig.livroFinanceiroRepository.marcarLancamentosComoTransferidos(
      [lancamento.id],
      new Date('2026-08-06T10:00:00.000Z'),
    );

    await expect(
      rig.caller.admin.pagamentos.estornar({ idPagamento: pagamento.id }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'lancamento_ja_transferido',
    });

    // No partial state: pagamento stays aprovado.
    const persisted = await rig.pagamentoRepository.findById(pagamento.id);
    expect(persisted?.status).toBe('aprovado');
  });

  it('maps a non-aprovado (pendente) pagamento to CONFLICT pagamento_status_invalido', async () => {
    const id = randomUUID();
    const idCampanha = randomUUID();
    campanhaPlataformaById.set(idCampanha, ID_PLATAFORMA_EUNENEM);
    const pendente = makePagamento({
      id: id as never,
      idCampanha,
      idContribuicao: randomUUID() as never,
      criadoEm: T0,
      metodo: 'pix',
    });
    await rig.pagamentoRepository.save(pendente);

    await expect(rig.caller.admin.pagamentos.estornar({ idPagamento: id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'pagamento_status_invalido',
    });
  });

  it('maps an unknown idPagamento to NOT_FOUND pagamento_nao_encontrado', async () => {
    await expect(
      rig.caller.admin.pagamentos.estornar({ idPagamento: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'pagamento_nao_encontrado',
    });
  });

  it('rejects a caller whose email is not in the admin allowlist with FORBIDDEN', async () => {
    const pagamento = await seedAprovadoStripe(rig);

    await expect(
      rig.nonAdminCaller.admin.pagamentos.estornar({ idPagamento: pagamento.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The gate fired before the use-case: nothing moved.
    const persisted = await rig.pagamentoRepository.findById(pagamento.id);
    expect(persisted?.status).toBe('aprovado');
  });

  // aperture-irhxi QA (Izzy/GLaDOS hold 3): cross-PLATFORM authz. An
  // allowlisted EuNeném admin must NOT be able to refund a payment that
  // belongs to a DIFFERENT platform — resolveAdminPagamentoContext rejects
  // it BEFORE any provider / refund-repository I/O.
  it('rejects estornar on a cross-platform (non-EuNeném) pagamento with FORBIDDEN — zero provider/repo work', async () => {
    const pagamento = await seedAprovadoStripe(rig, {
      idPlataforma: 'PLATAFORMA_EUCASEI_00000000000000000',
    });
    await seedLancamentoRecebedor(rig, pagamento);

    await expect(
      rig.caller.admin.pagamentos.estornar({ idPagamento: pagamento.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // No money moved, no provider call, no ledger cancellation.
    const persisted = await rig.pagamentoRepository.findById(pagamento.id);
    expect(persisted?.status).toBe('aprovado');
    expect(rig.pixCobrancaProvider.solicitarDevolucaoCalls).toBe(0);
    const lancamentos = await rig.livroFinanceiroRepository.findLancamentosByIdPagamento(
      pagamento.id,
    );
    expect(lancamentos[0]?.canceladoEm ?? null).toBeNull();
  });
});

describe('admin.pagamentos.devolucaoStatus (aperture-4uvgf)', () => {
  let rig: TestRig;
  beforeEach(() => {
    campanhaPlataformaById.clear();
    rig = buildRig();
  });

  it('returns { devolucao: null } for a Stripe-provenance pagamento (no devolução row)', async () => {
    const pagamento = await seedAprovadoStripe(rig);

    const status = await rig.caller.admin.pagamentos.devolucaoStatus({
      idPagamento: pagamento.id,
    });
    expect(status.devolucao).toBeNull();
  });

  // aperture-irhxi QA (hold 3): reading a cross-platform payment's refund
  // lifecycle is also a tenant leak — the same guard blocks it.
  it('rejects devolucaoStatus on a cross-platform pagamento with FORBIDDEN', async () => {
    const pagamento = await seedAprovadoStripe(rig, {
      idPlataforma: 'PLATAFORMA_EUCASEI_00000000000000000',
    });

    await expect(
      rig.caller.admin.pagamentos.devolucaoStatus({ idPagamento: pagamento.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
