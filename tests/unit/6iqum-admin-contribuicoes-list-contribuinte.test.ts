/**
 * Tests for aperture-6iqum — admin.contribuicoes.listByCampanha
 * contribuinte projection.
 *
 * Bug: admin contribuições list rendered "(sem contribuinte)" for
 * every PRESENTEADA row because ContribuicaoAdminDTO didn't carry a
 * `contribuinte` field. Phase 1 dropped contribuicao.contribuinte; the
 * per-pagamento projection (xfw5c #146) fixed PagamentoAdminDTO but
 * this list view was missed.
 *
 * Fix: ContribuicaoAdminDTOSchema gains `contribuinte` field projected
 * from the most-recent aprovado pagamento's intencao.contribuinte via
 * a new bulk port (findContribuintesFromLatestAprovadoPagamento) —
 * same N+1-avoidance pattern as findIdsContribuicoesComPagamentoAprovado.
 *
 * Tests cover:
 *   (A) PORT-LEVEL — PagamentoRepositoryMemory bulk method:
 *       - Single aprovado pagamento with contribuinte → Map entry
 *       - Anonymous (null contribuinte) on aprovado → null entry
 *       - Multiple aprovado pagamentos → MOST RECENT one wins
 *       - No aprovado pagamento → key absent from Map
 *       - Mensagem undefined handling
 *       - Empty input fast-path
 *   (B) ROUTER-LEVEL — listByCampanha projects through correctly
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import type { IdContribuicaoPagamento } from '../../src/domain/pagamentos/value-objects/ids.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { makePagamento as makePagamentoBase } from '../helpers/pagamento-repository.conformance.js';

function makePagamento(args: {
  id?: string;
  idContribuicao: string;
  status?: 'pendente' | 'processing' | 'aprovado' | 'rejeitado' | 'estornado';
  criadoEm?: Date;
  contribuinte?: { nome: string; email: string; mensagem?: string } | null;
}) {
  return makePagamentoBase({
    id: args.id,
    idContribuicao: args.idContribuicao,
    status: (args.status ?? 'aprovado') as never,
    criadoEm: args.criadoEm ?? new Date('2026-06-04T10:00:00.000Z'),
    contribuinte: (args.contribuinte === undefined ? null : args.contribuinte) as never,
  });
}

// ────────────────────────────────────────────────────────────────────
//  (A) Port-level: findContribuintesFromLatestAprovadoPagamento
// ────────────────────────────────────────────────────────────────────

describe('PagamentoRepositoryMemory.findContribuintesFromLatestAprovadoPagamento', () => {
  let repo: PagamentoRepositoryMemory;
  beforeEach(() => {
    repo = new PagamentoRepositoryMemory();
  });

  it('returns Map entry with contribuinte for single aprovado pagamento', async () => {
    const idC = randomUUID();
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        contribuinte: { nome: 'Teste Teste', email: 't@x.com' },
      }),
    );

    const map = await repo.findContribuintesFromLatestAprovadoPagamento([
      idC as unknown as IdContribuicaoPagamento,
    ]);
    expect(map.get(idC)).toEqual({ nome: 'Teste Teste', email: 't@x.com' });
  });

  it('returns null entry for aprovado pagamento with null contribuinte (anonymous)', async () => {
    const idC = randomUUID();
    await repo.save(makePagamento({ idContribuicao: idC, contribuinte: null }));

    const map = await repo.findContribuintesFromLatestAprovadoPagamento([
      idC as unknown as IdContribuicaoPagamento,
    ]);
    expect(map.has(idC)).toBe(true);
    expect(map.get(idC)).toBeNull();
  });

  it('picks the MOST RECENT aprovado pagamento when multiple exist (recency wins)', async () => {
    const idC = randomUUID();
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        criadoEm: new Date('2026-05-01T08:00:00Z'),
        contribuinte: { nome: 'Primeira', email: 'p@x.com' },
      }),
    );
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        criadoEm: new Date('2026-06-01T08:00:00Z'),
        contribuinte: { nome: 'Mais Recente', email: 'r@x.com' },
      }),
    );
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        criadoEm: new Date('2026-04-01T08:00:00Z'),
        contribuinte: { nome: 'Antiga', email: 'a@x.com' },
      }),
    );

    const map = await repo.findContribuintesFromLatestAprovadoPagamento([
      idC as unknown as IdContribuicaoPagamento,
    ]);
    expect(map.get(idC)).toEqual({ nome: 'Mais Recente', email: 'r@x.com' });
  });

  it('key absent from Map when no aprovado pagamento exists', async () => {
    const idC = randomUUID();
    // Only non-aprovado payments
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        status: 'pendente',
        contribuinte: { nome: 'Aguardando', email: 'p@x.com' },
      }),
    );

    const map = await repo.findContribuintesFromLatestAprovadoPagamento([
      idC as unknown as IdContribuicaoPagamento,
    ]);
    expect(map.has(idC)).toBe(false);
  });

  it('preserves mensagem when present on the contribuinte', async () => {
    const idC = randomUUID();
    await repo.save(
      makePagamento({
        idContribuicao: idC,
        contribuinte: {
          nome: 'Com Recado',
          email: 'r@x.com',
          mensagem: 'parabéns!',
        },
      }),
    );

    const map = await repo.findContribuintesFromLatestAprovadoPagamento([
      idC as unknown as IdContribuicaoPagamento,
    ]);
    expect(map.get(idC)).toEqual({
      nome: 'Com Recado',
      email: 'r@x.com',
      mensagem: 'parabéns!',
    });
  });

  it('empty input → empty Map (fast-path, no scan)', async () => {
    const map = await repo.findContribuintesFromLatestAprovadoPagamento([]);
    expect(map.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) Router-level: listByCampanha projection
// ────────────────────────────────────────────────────────────────────

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  pagamentoRepository: PagamentoRepositoryMemory;
  contribuicaoRepository: ContribuicaoRepositoryMemory;
  idCampanha: string;
}

async function buildRig(): Promise<TestRig> {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

  const idCampanha = randomUUID();
  await campanhaRepository.save({
    id: idCampanha as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    idsAdministradores: [],
    titulo: 'T',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

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
    livroFinanceiroRepository,
    provedorRegraTaxa: {} as never,
    observability,
    clock: () => new Date(),
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

  return {
    caller: appRouter.createCaller(ctx),
    pagamentoRepository,
    contribuicaoRepository,
    idCampanha,
  };
}

async function seedContribuicao(rig: TestRig, args?: { nome?: string }): Promise<string> {
  const id = randomUUID();
  await rig.contribuicaoRepository.save({
    id: id as never,
    idCampanha: rig.idCampanha as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: args?.nome ?? 'Gift',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    quantidade: 1 as never,
    criadaEm: new Date(),
  } as never);
  return id;
}

describe('admin.contribuicoes.listByCampanha — contribuinte projection (aperture-6iqum)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('row carries contribuinte when most-recent aprovado pagamento has one', async () => {
    const idC = await seedContribuicao(rig);
    await rig.pagamentoRepository.save(
      makePagamento({
        idContribuicao: idC,
        contribuinte: { nome: 'Teste Teste', email: 't@x.com' },
      }),
    );

    const result = await rig.caller.admin.contribuicoes.listByCampanha({
      idCampanha: rig.idCampanha,
    });
    expect(result.contribuicoes).toHaveLength(1);
    expect(result.contribuicoes[0].contribuinte).toEqual({
      nome: 'Teste Teste',
      email: 't@x.com',
      mensagem: null,
    });
    // Plan 0016 Phase 4 (aperture-3htxg): the admin DTO replaced the binary
    // `indisponivel` field with `quantidadeRestante`. Sold out (quantidade=1,
    // sold=1) → quantidadeRestante <= 0.
    expect(result.contribuicoes[0].quantidadeRestante).toBeLessThanOrEqual(0);
  });

  it('row.contribuinte is null when no aprovado pagamento exists (gift unclaimed)', async () => {
    await seedContribuicao(rig);

    const result = await rig.caller.admin.contribuicoes.listByCampanha({
      idCampanha: rig.idCampanha,
    });
    expect(result.contribuicoes[0].contribuinte).toBeNull();
    // No aprovado pagamento → nothing sold → slot still available.
    expect(result.contribuicoes[0].quantidadeRestante).toBeGreaterThan(0);
  });

  it('row.contribuinte is null for anonymous aprovado (contribuinte was null on pagamento)', async () => {
    const idC = await seedContribuicao(rig);
    await rig.pagamentoRepository.save(makePagamento({ idContribuicao: idC, contribuinte: null }));

    const result = await rig.caller.admin.contribuicoes.listByCampanha({
      idCampanha: rig.idCampanha,
    });
    expect(result.contribuicoes[0].contribuinte).toBeNull();
    // Anonymous but aprovado → still sold → quantidadeRestante <= 0.
    expect(result.contribuicoes[0].quantidadeRestante).toBeLessThanOrEqual(0);
  });

  it('mensagem undefined on engine entity → null on wire (boundary normalization)', async () => {
    const idC = await seedContribuicao(rig);
    await rig.pagamentoRepository.save(
      makePagamento({
        idContribuicao: idC,
        contribuinte: { nome: 'Sem Recado', email: 'r@x.com' }, // mensagem omitted
      }),
    );

    const result = await rig.caller.admin.contribuicoes.listByCampanha({
      idCampanha: rig.idCampanha,
    });
    expect(result.contribuicoes[0].contribuinte).toEqual({
      nome: 'Sem Recado',
      email: 'r@x.com',
      mensagem: null,
    });
  });

  it('multiple rows: each row carries its own most-recent aprovado contribuinte', async () => {
    const idC1 = await seedContribuicao(rig, { nome: 'Gift A' });
    const idC2 = await seedContribuicao(rig, { nome: 'Gift B' });
    await rig.pagamentoRepository.save(
      makePagamento({
        idContribuicao: idC1,
        contribuinte: { nome: 'Alice', email: 'a@x.com' },
      }),
    );
    await rig.pagamentoRepository.save(
      makePagamento({
        idContribuicao: idC2,
        contribuinte: { nome: 'Bob', email: 'b@x.com' },
      }),
    );

    const result = await rig.caller.admin.contribuicoes.listByCampanha({
      idCampanha: rig.idCampanha,
    });
    const byId = new Map(result.contribuicoes.map((c) => [c.id, c]));
    expect(byId.get(idC1)?.contribuinte?.nome).toBe('Alice');
    expect(byId.get(idC2)?.contribuinte?.nome).toBe('Bob');
  });
});
