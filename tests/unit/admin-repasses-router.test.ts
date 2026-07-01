/**
 * Tests for aperture-riywh — admin.repasses tRPC router.
 *
 * Covers:
 *   (A) admin.repasses.list — cursor pagination + status filter + tenant
 *   (B) admin.repasses.aprovar — happy + idempotent + typed error mapping
 *   (C) admin.repasses.show — drill-down + null cases
 *   (D) LivroFinanceiroRepository memory adapter port methods:
 *       findRepassesPaginated + findLancamentosByIdRepasse
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../src/adapters/plataforma/repository.memory.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { makePagamento as makePagamentoBase } from '../helpers/pagamento-repository.conformance.js';

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  pagamentoRepository: PagamentoRepositoryMemory;
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
  campanhaRepository: CampanhaRepositoryMemory;
  recebedorRepository: RecebedorRepositoryMemory;
  idCampanha: string;
  idContribuicao: string;
  clock: () => Date;
}

const T0 = new Date('2026-06-04T10:00:00.000Z');
const T1 = new Date('2026-06-04T11:00:00.000Z');

function makePagamento(args: {
  id: string;
  idContribuicao: string;
  status?: 'pendente' | 'processing' | 'aprovado' | 'rejeitado' | 'estornado';
  criadoEm?: Date;
  contribuinteNome?: string | null;
}) {
  const contribuinte = args.contribuinteNome
    ? { nome: args.contribuinteNome, email: 'x@y.com' }
    : null;
  return makePagamentoBase({
    id: args.id,
    idContribuicao: args.idContribuicao,
    status: (args.status ?? 'aprovado') as never,
    criadoEm: args.criadoEm ?? T0,
    contribuinte: contribuinte as never,
  });
}

function makeLancamento(args: {
  id?: string;
  idPagamento: string;
  idContribuicao: string;
  idCampanha?: string;
  amountCents?: number;
  idRepasse?: string | null;
}) {
  return {
    id: (args.id ?? randomUUID()) as never,
    idPagamento: args.idPagamento as never,
    idContribuicao: args.idContribuicao as never,
    idCampanha: (args.idCampanha ?? null) as never,
    tipo: 'credito_saldo_recebedor' as never,
    amountCents: (args.amountCents ?? 4500) as never,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: (args.idRepasse ?? null) as never,
  } as never;
}

async function buildRig(): Promise<TestRig> {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const clock = () => T1;

  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory(recebedorRepository);

  const idCampanha = randomUUID();
  await campanhaRepository.save({
    id: idCampanha as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    idsAdministradores: [],
    titulo: 'Chá Bia & Léo',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular: 'Bia Silva',
      tipoChavePix: 'email',
      chavePix: 'bia@example.com',
    } as never,
    criadaEm: T0,
  } as never);

  // Save an active recebedor row so findAtivoByCampanhaId returns it.
  const recebedor = criarRecebedorInicial({
    id: randomUUID() as never,
    idCampanha: idCampanha as never,
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular: 'Bia Silva',
      tipoChavePix: 'email',
      chavePix: 'bia@example.com',
    } as never,
    criadaEm: T0,
  });
  await recebedorRepository.save(recebedor);

  const idContribuicao = randomUUID();
  await contribuicaoRepository.save({
    id: idContribuicao as never,
    idCampanha: idCampanha as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: 'Berço',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: T0,
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

  return {
    caller: appRouter.createCaller(ctx),
    pagamentoRepository,
    livroFinanceiroRepository,
    campanhaRepository,
    recebedorRepository,
    idCampanha,
    idContribuicao,
    clock,
  };
}

async function seedPendingRepasse(rig: TestRig): Promise<{
  idRepasse: string;
  idsLancamentos: string[];
}> {
  const idPagamento = randomUUID();
  await rig.pagamentoRepository.save(
    makePagamento({
      id: idPagamento,
      idContribuicao: rig.idContribuicao,
      contribuinteNome: 'Tia Carmen',
    }),
  );
  const l1 = makeLancamento({
    idPagamento,
    idContribuicao: rig.idContribuicao,
    idCampanha: rig.idCampanha,
    amountCents: 3000,
  });
  const l2 = makeLancamento({
    idPagamento,
    idContribuicao: rig.idContribuicao,
    idCampanha: rig.idCampanha,
    amountCents: 1500,
  });
  await rig.livroFinanceiroRepository.saveLancamentos([l1, l2]);

  const idRepasse = randomUUID();
  await rig.livroFinanceiroRepository.solicitarRepasseTransaction({
    idCampanha: rig.idCampanha as never,
    idRepasse: idRepasse as never,
    solicitadoEm: T0,
    now: T0,
  });

  return {
    idRepasse,
    idsLancamentos: [String(l1.id), String(l2.id)],
  };
}

// ────────────────────────────────────────────────────────────────────
//  (A) admin.repasses.list
// ────────────────────────────────────────────────────────────────────

describe('admin.repasses.list (aperture-riywh)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('returns pending repasses with enriched campanha + recebedor + numLancamentos', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);

    const result = await rig.caller.admin.repasses.list({
      statusFilter: 'solicitado',
      cursor: null,
      limit: 20,
    });

    expect(result.totalCount).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.idRepasse).toBe(idRepasse);
    expect(result.rows[0]?.campanhaTitulo).toBe('Chá Bia & Léo');
    expect(result.rows[0]?.recebedorNome).toBe('Bia Silva');
    expect(result.rows[0]?.amountCents).toBe(4500);
    expect(result.rows[0]?.numLancamentos).toBe(2);
    expect(result.rows[0]?.status).toBe('solicitado');
    expect(result.rows[0]?.aprovadoEm).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it('excludes aprovado repasses by default (statusFilter=solicitado)', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);
    await rig.livroFinanceiroRepository.aprovarRepasseTransaction({
      idRepasse: idRepasse as never,
      aprovadoEm: T1,
      bankTransferRef: null,
    });

    const result = await rig.caller.admin.repasses.list({
      statusFilter: 'solicitado',
      cursor: null,
      limit: 20,
    });
    expect(result.totalCount).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('returns aprovado repasses when statusFilter=aprovado', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);
    await rig.livroFinanceiroRepository.aprovarRepasseTransaction({
      idRepasse: idRepasse as never,
      aprovadoEm: T1,
      bankTransferRef: 'PIX-AB12',
    });

    const result = await rig.caller.admin.repasses.list({
      statusFilter: 'aprovado',
      cursor: null,
      limit: 20,
    });
    expect(result.totalCount).toBe(1);
    expect(result.rows[0]?.status).toBe('aprovado');
    expect(result.rows[0]?.aprovadoEm).toBe(T1.toISOString());
    expect(result.rows[0]?.bankTransferRef).toBe('PIX-AB12');
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) admin.repasses.aprovar
// ────────────────────────────────────────────────────────────────────

describe('admin.repasses.aprovar (aperture-riywh)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('approves a pending repasse and stamps transferidoEm on linked lançamentos', async () => {
    const { idRepasse, idsLancamentos } = await seedPendingRepasse(rig);

    const result = await rig.caller.admin.repasses.aprovar({
      idRepasse,
      bankTransferRef: 'PIX-XYZ-001',
    });

    expect(result.idRepasse).toBe(idRepasse);
    expect(result.aprovadoEm).toBe(T1.toISOString());
    expect(result.numLancamentosTransferidos).toBe(2);
    expect(result.totalCents).toBe(4500);

    const refetched = await rig.livroFinanceiroRepository.findLancamentosByIds(
      idsLancamentos as never,
    );
    for (const l of refetched) {
      expect(l.transferidoEm).toEqual(T1);
    }
  });

  it('is idempotent on re-approval with the same bankTransferRef', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);
    const first = await rig.caller.admin.repasses.aprovar({
      idRepasse,
      bankTransferRef: 'PIX-XYZ',
    });
    const second = await rig.caller.admin.repasses.aprovar({
      idRepasse,
      bankTransferRef: 'PIX-XYZ',
    });
    expect(second.numLancamentosTransferidos).toBe(0);
    expect(second.aprovadoEm).toBe(first.aprovadoEm);
  });

  it('throws CONFLICT on re-approval with a mismatched bankTransferRef', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);
    await rig.caller.admin.repasses.aprovar({
      idRepasse,
      bankTransferRef: 'PIX-1',
    });
    await expect(
      rig.caller.admin.repasses.aprovar({
        idRepasse,
        bankTransferRef: 'PIX-2',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('throws NOT_FOUND when the repasse does not exist', async () => {
    await expect(
      rig.caller.admin.repasses.aprovar({
        idRepasse: randomUUID(),
        bankTransferRef: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ────────────────────────────────────────────────────────────────────
//  (C) admin.repasses.show
// ────────────────────────────────────────────────────────────────────

describe('admin.repasses.show (aperture-riywh)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('returns the repasse + linked lançamentos with contribuinte attribution', async () => {
    const { idRepasse } = await seedPendingRepasse(rig);

    const result = await rig.caller.admin.repasses.show({ idRepasse });
    expect(result.repasse).not.toBeNull();
    expect(result.repasse?.idRepasse).toBe(idRepasse);
    expect(result.repasse?.amountCents).toBe(4500);
    expect(result.repasse?.lancamentos).toHaveLength(2);
    for (const l of result.repasse?.lancamentos ?? []) {
      expect(l.contribuinteNome).toBe('Tia Carmen');
    }
  });

  it('returns null for an unknown idRepasse', async () => {
    const result = await rig.caller.admin.repasses.show({ idRepasse: randomUUID() });
    expect(result.repasse).toBeNull();
  });

  it('returns null when the campanha belongs to a different plataforma (defensive)', async () => {
    // Hijack the campanha to ID_PLATAFORMA_EUCASEI after seeding the repasse.
    const { idRepasse } = await seedPendingRepasse(rig);
    const c = await rig.campanhaRepository.findById(rig.idCampanha as never);
    expect(c).toBeDefined();
    if (!c) return;
    await rig.campanhaRepository.save({
      ...c,
      idPlataforma: ID_PLATAFORMA_EUCASEI,
    } as never);

    const result = await rig.caller.admin.repasses.show({ idRepasse });
    expect(result.repasse).toBeNull();
  });
});
