/**
 * Tests for aperture-7g5sx — recebedor.extrato + recebedor.transferencia
 * tRPC router (Track 2 of aperture-q2d4b).
 *
 * Covers:
 *   (A) extrato.summary — KPI aggregation (totalRecebido, resgatado,
 *       saldoDisponivel, aguardandoLiberacao, proximaTransfDate,
 *       totalPresentes, dateRangeStart/end)
 *   (B) extrato.list — sort + cursor pagination + status filters +
 *       contribuinte nome attribution from intencao
 *   (C) transferencia.solicitar — happy path + RepasseJaPendente
 *       (CONFLICT) + SaldoInsuficiente (UNPROCESSABLE_CONTENT)
 *   (D) Auth gating — wrong-tenant / missing-session → UNAUTHORIZED
 *
 * The auth helper (resolveAdminOfCampanha) is stubbed with minimal
 * authService + usuarioRepository implementations that return a fixed
 * session + usuario for a known cookie token.
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
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';

const SESSION_COOKIE = 'better-auth.session_token';
const SESSION_TOKEN = 'tok_test_session';
const FAKE_NOW = new Date('2026-06-04T12:00:00.000Z');

function makePagamento(args: {
  id: string;
  idContribuicao: string;
  status?: 'pendente' | 'processing' | 'aprovado' | 'rejeitado' | 'estornado';
  availableOn?: Date | null;
  criadoEm?: Date;
  contribuinteNome?: string | null;
}) {
  const criadoEm = args.criadoEm ?? FAKE_NOW;
  return {
    id: args.id as never,
    status: (args.status ?? 'aprovado') as never,
    criadoEm,
    atualizadoEm: criadoEm,
    intencao: {
      id: randomUUID() as never,
      idContribuicao: args.idContribuicao as never,
      criadaEm: criadoEm,
      metodo: 'pix',
      amountCents: 4500 as never,
      externalRef: null,
      paymentIntentExternalRef: null,
      chargeExternalRef: null,
      balanceTransactionAvailableOn: args.availableOn === undefined ? FAKE_NOW : args.availableOn,
      contribuinte:
        args.contribuinteNome === null || args.contribuinteNome === undefined
          ? null
          : { nome: args.contribuinteNome, email: 'x@y.com' },
      composicaoValores: {
        idContribuicao: args.idContribuicao,
        contributionAmountCents: 4500 as never,
        feeAmountCents: 0 as never,
        surchargeCents: 0 as never,
        receiverAmountCents: 4500 as never,
        totalPaidCents: 4500 as never,
        responsavelTaxa: 'contribuinte',
      } as never,
    } as never,
  } as never;
}

function makeLancamento(args: {
  id?: string;
  idPagamento: string;
  idContribuicao: string;
  idCampanha: string;
  amountCents?: number;
  tipo?: 'credito_saldo_recebedor' | 'credito_receita_plataforma' | 'credito_passthrough_surcharge';
  transferidoEm?: Date | null;
  canceladoEm?: Date | null;
  idRepasse?: string | null;
}) {
  return {
    id: (args.id ?? randomUUID()) as never,
    idPagamento: args.idPagamento as never,
    idContribuicao: args.idContribuicao as never,
    idCampanha: args.idCampanha as never,
    tipo: (args.tipo ?? 'credito_saldo_recebedor') as never,
    amountCents: (args.amountCents ?? 4500) as never,
    criadoEm: FAKE_NOW,
    transferidoEm: args.transferidoEm ?? null,
    canceladoEm: args.canceladoEm ?? null,
    idRepasse: args.idRepasse ?? null,
  } as never;
}

interface TestRig {
  caller: ReturnType<typeof appRouter.createCaller>;
  callerAnon: ReturnType<typeof appRouter.createCaller>;
  campanhaRepository: CampanhaRepositoryMemory;
  contribuicaoRepository: ContribuicaoRepositoryMemory;
  pagamentoRepository: PagamentoRepositoryMemory;
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory;
  idCampanha: string;
  idCampanhaOutsider: string;
  idContribuicao: string;
}

async function buildRig(): Promise<TestRig> {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };

  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

  const idConta = randomUUID();
  const idUsuario = randomUUID();
  const idCampanha = randomUUID();
  await campanhaRepository.save({
    id: idCampanha as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    idsAdministradores: [idConta] as never,
    titulo: 'T',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

  const idCampanhaOutsider = randomUUID();
  await campanhaRepository.save({
    id: idCampanhaOutsider as never,
    idPlataforma: ID_PLATAFORMA_EUNENEM as never,
    idsAdministradores: [randomUUID()] as never,
    titulo: 'OUTSIDER',
    opcoes: [],
    idRecebedor: null,
    dadosRecebedor: null,
    criadaEm: new Date(),
  } as never);

  const idContribuicao = randomUUID();
  await contribuicaoRepository.save({
    id: idContribuicao as never,
    idCampanha: idCampanha as never,
    idOpcaoContribuicao: randomUUID() as never,
    nome: 'T',
    valor: 4500 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  } as never);

  // Minimal authService + usuarioRepository: return the same session/usuario
  // for the known SESSION_TOKEN; return null otherwise.
  const authService = {
    validarSessao: async (token: string) =>
      token === SESSION_TOKEN
        ? { idUsuario: idUsuario as never, token, expiresAt: new Date(Date.now() + 3600_000) }
        : null,
  };
  const usuarioRepository = {
    findUsuarioById: async (id: string) =>
      id === idUsuario
        ? { idConta: idConta as never, idUsuario: id, nomeExibicao: 'T', email: 't@t.com' }
        : null,
  };

  const deps = {
    db: {} as never,
    auth: {} as never,
    authService: authService as never,
    usuarioRepository: usuarioRepository as never,
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
    clock: () => FAKE_NOW,
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    webhookEventArchive: {} as never,
  } as unknown as ServerDeps;

  const cookieHeaders = new Headers();
  cookieHeaders.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(SESSION_TOKEN)}`);
  const ctxAuthed: TrpcContext = {
    deps,
    headers: cookieHeaders,
    resHeaders: new Headers(),
  };
  const ctxAnon: TrpcContext = {
    deps,
    headers: new Headers(),
    resHeaders: new Headers(),
  };

  return {
    caller: appRouter.createCaller(ctxAuthed),
    callerAnon: appRouter.createCaller(ctxAnon),
    campanhaRepository,
    contribuicaoRepository,
    pagamentoRepository,
    livroFinanceiroRepository,
    idCampanha,
    idCampanhaOutsider,
    idContribuicao,
  };
}

// ────────────────────────────────────────────────────────────────────
//  (D) Auth gating
// ────────────────────────────────────────────────────────────────────

describe('recebedor.extrato.summary — auth gating (aperture-7g5sx)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('anonymous caller → UNAUTHORIZED', async () => {
    await expect(
      rig.callerAnon.recebedor.extrato.summary({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('different-tenant campanha → UNAUTHORIZED (no leak)', async () => {
    await expect(
      rig.caller.recebedor.extrato.summary({ idCampanha: rig.idCampanhaOutsider }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('unknown campanha id → UNAUTHORIZED (no existence leak)', async () => {
    await expect(
      rig.caller.recebedor.extrato.summary({ idCampanha: randomUUID() }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

// ────────────────────────────────────────────────────────────────────
//  (A) extrato.summary KPI math
// ────────────────────────────────────────────────────────────────────

describe('recebedor.extrato.summary — KPI aggregation (aperture-7g5sx)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('empty campanha returns zeroed totals + null date fields', async () => {
    const result = await rig.caller.recebedor.extrato.summary({
      idCampanha: rig.idCampanha,
    });
    expect(result).toEqual({
      totalRecebidoCents: 0,
      resgatadoCents: 0,
      saldoDisponivelCents: 0,
      aguardandoAprovacaoCents: 0,
      aguardandoLiberacaoCents: 0,
      proximaTransfDate: null,
      totalPresentes: 0,
      dateRangeStart: null,
      dateRangeEnd: null,
    });
  });

  it('aggregates disponivel + aguardando_liberacao + transferido buckets correctly', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const future = new Date('2026-06-10T10:00:00.000Z');

    // PAGAMENTO 1: aprovado, availableOn past → disponivel
    const idPag1 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag1,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-01T08:00:00.000Z'),
      }),
    );
    // PAGAMENTO 2: aprovado, availableOn future → aguardando_liberacao
    const idPag2 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag2,
        idContribuicao: rig.idContribuicao,
        availableOn: future,
        criadoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    );
    // PAGAMENTO 3: aprovado, transferidoEm set → transferido (resgatado)
    const idPag3 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag3,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-03T08:00:00.000Z'),
      }),
    );

    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag1,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
      }),
      makeLancamento({
        idPagamento: idPag2,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 3000,
      }),
      makeLancamento({
        idPagamento: idPag3,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 2000,
        transferidoEm: past,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.summary({
      idCampanha: rig.idCampanha,
    });

    expect(result.totalRecebidoCents).toBe(9500); // 4500 + 3000 + 2000
    expect(result.saldoDisponivelCents).toBe(4500); // pag1
    expect(result.aguardandoLiberacaoCents).toBe(3000); // pag2
    expect(result.resgatadoCents).toBe(2000); // pag3
    expect(result.totalPresentes).toBe(3);
    expect(result.proximaTransfDate).toBe(future.toISOString());
    expect(result.dateRangeStart).toBe('2026-06-01T08:00:00.000Z');
    expect(result.dateRangeEnd).toBe('2026-06-03T08:00:00.000Z');
  });

  it('cancelado lançamentos are EXCLUDED from all totals (refund posture)', async () => {
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({ id: idPag, idContribuicao: rig.idContribuicao }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
        canceladoEm: FAKE_NOW,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.summary({
      idCampanha: rig.idCampanha,
    });
    expect(result.totalRecebidoCents).toBe(0);
    expect(result.totalPresentes).toBe(0);
  });

  it('excludes non-saldo_recebedor tipos (plataforma + passthrough surcharge)', async () => {
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({ id: idPag, idContribuicao: rig.idContribuicao }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
        tipo: 'credito_saldo_recebedor',
      }),
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 500,
        tipo: 'credito_receita_plataforma',
      }),
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 200,
        tipo: 'credito_passthrough_surcharge',
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.summary({
      idCampanha: rig.idCampanha,
    });
    expect(result.totalRecebidoCents).toBe(4500); // ONLY saldo_recebedor counted
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) extrato.list
// ────────────────────────────────────────────────────────────────────

describe('recebedor.extrato.list — rows + sort + filter + contribuinte (aperture-7g5sx)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('returns rows with contribuinteNome attribution from pagamento.intencao', async () => {
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        contribuinteNome: 'Teste Teste',
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].contribuinteNome).toBe('Teste Teste');
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('liberacaoPrevistaEm populated for aguardando_liberacao rows (aperture-75mw3)', async () => {
    const future = new Date('2026-06-10T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: future, // future → aguardando_liberacao
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].liberacao).toBe('aguardando_liberacao');
    expect(result.rows[0].liberacaoPrevistaEm).toBe(future.toISOString());
  });

  it('liberacaoPrevistaEm null for non-aguardando rows (disponivel/transferido) (aperture-75mw3)', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: past, // past → disponivel
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].liberacao).toBe('disponivel');
    expect(result.rows[0].liberacaoPrevistaEm).toBeNull();
  });

  it('liberacaoPrevistaEm null when webhook hasnt populated availableOn yet (aperture-75mw3 + 1ewwh edge)', async () => {
    // Aguardando but availableOn=null (orphan window — pi.succeeded
    // bailed, cs.completed hasn't run yet, OR Stripe API returned null).
    // The row still shows aguardando_liberacao but the predicted date is
    // unknown; UI falls back to neutral copy.
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: null, // orphan / unknown
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].liberacao).toBe('aguardando_liberacao');
    expect(result.rows[0].liberacaoPrevistaEm).toBeNull();
  });

  it('null contribuinte on pagamento → null contribuinteNome on row', async () => {
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        contribuinteNome: null,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].contribuinteNome).toBeNull();
  });

  it('statusFilters narrows rows (aguardando_liberacao only)', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const future = new Date('2026-06-10T10:00:00.000Z');
    const idPagDisp = randomUUID();
    const idPagAgu = randomUUID();

    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagDisp,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-01T08:00:00.000Z'),
      }),
    );
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagAgu,
        idContribuicao: rig.idContribuicao,
        availableOn: future,
        criadoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    );

    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPagDisp,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
      makeLancamento({
        idPagamento: idPagAgu,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: ['aguardando_liberacao'],
      cursor: null,
      limit: 20,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].liberacao).toBe('aguardando_liberacao');
    expect(result.rows[0].idPagamento).toBe(idPagAgu);
  });

  it('cursor pagination — DESC sort with id ASC tiebreaker, hasMore + nextCursor', async () => {
    // Three pagamentos with different criadoEm — pagination splits.
    const t1 = new Date('2026-06-01T08:00:00.000Z');
    const t2 = new Date('2026-06-02T08:00:00.000Z');
    const t3 = new Date('2026-06-03T08:00:00.000Z');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const dates = [t1, t2, t3];
    for (let i = 0; i < 3; i++) {
      const idPag = ids[i] as string;
      await rig.pagamentoRepository.save(
        makePagamento({
          id: idPag,
          idContribuicao: rig.idContribuicao,
          criadoEm: dates[i] as Date,
        }),
      );
      await rig.livroFinanceiroRepository.saveLancamentos([
        makeLancamento({
          idPagamento: idPag,
          idContribuicao: rig.idContribuicao,
          idCampanha: rig.idCampanha,
        }),
      ]);
    }

    // Page 1 (limit 2): expect t3, t2.
    const page1 = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 2,
    });
    expect(page1.rows.map((r) => r.idPagamento)).toEqual([ids[2], ids[1]]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2 (cursor from page1.nextCursor): expect t1.
    const page2 = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.rows.map((r) => r.idPagamento)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
//  (C) transferencia.solicitar
// ────────────────────────────────────────────────────────────────────

describe('recebedor.transferencia.solicitar (aperture-7g5sx)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('SaldoInsuficiente (no disponivel rows) → UNPROCESSABLE_CONTENT', async () => {
    // Empty campanha — no disponivel lançamentos to sweep.
    await expect(
      rig.caller.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE_CONTENT',
      message: 'saldo_disponivel_insuficiente',
    });
  });

  it('happy path: sweeps disponivel rows + creates solicitado repasse', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
      }),
    ]);

    const result = await rig.caller.recebedor.transferencia.solicitar({
      idCampanha: rig.idCampanha,
    });

    expect(result.amountCents).toBe(4500);
    expect(result.numLancamentos).toBe(1);
    expect(result.solicitadoEm).toBe(FAKE_NOW.toISOString());
    expect(result.idRepasse).toBeTruthy();
  });

  it('RepasseJaPendente — re-solicit on fresh disponivel while one is already solicitado → CONFLICT', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');

    // First disponivel: gets swept into the first solicitado repasse.
    const idPag1 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag1,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag1,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
      }),
    ]);

    // First call: succeeds (sweeps the disponivel row, mints solicitado repasse).
    await rig.caller.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha });

    // SECOND fresh disponivel row arrives AFTER the first repasse was solicited.
    // The second solicit() would normally sweep this — but the unique partial
    // index on (idCampanha) WHERE status='solicitado' rejects the create.
    const idPag2 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag2,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag2,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 3000,
      }),
    ]);

    await expect(
      rig.caller.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'repasse_ja_pendente',
    });
  });

  it('anonymous caller → UNAUTHORIZED (auth gating applies to mutation too)', async () => {
    await expect(
      rig.callerAnon.recebedor.transferencia.solicitar({ idCampanha: rig.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

// ────────────────────────────────────────────────────────────────────
//  (E) Gift name + imagemUrl projection (aperture-k6fbz)
// ────────────────────────────────────────────────────────────────────

describe('recebedor.extrato.list — contribuicaoNome + contribuicaoImagemUrl (aperture-k6fbz)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('row.contribuicaoNome projects from the contribuição linked via pagamento.intencao', async () => {
    // Override the default seeded contribuição with a recognisable name + image.
    const idC = randomUUID();
    await rig.contribuicaoRepository.save({
      id: idC as never,
      idCampanha: rig.idCampanha as never,
      idOpcaoContribuicao: randomUUID() as never,
      nome: 'Berço Montessoriano',
      valor: 4500 as never,
      imagemUrl: '🍼',
      grupo: null,
      criadaEm: new Date(),
    } as never);

    const idPag = randomUUID();
    await rig.pagamentoRepository.save(makePagamento({ id: idPag, idContribuicao: idC }));
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: idC,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });

    expect(result.rows[0].contribuicaoNome).toBe('Berço Montessoriano');
    expect(result.rows[0].contribuicaoImagemUrl).toBe('🍼');
  });

  it('row.contribuicaoImagemUrl is null when the contribuição has no image attached', async () => {
    // Default seeded contribuição (rig.idContribuicao) has nome='T' + imagemUrl=null.
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({ id: idPag, idContribuicao: rig.idContribuicao }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });

    expect(result.rows[0].contribuicaoNome).toBe('T');
    expect(result.rows[0].contribuicaoImagemUrl).toBeNull();
  });

  it('multiple rows: each row carries its own gift name/image', async () => {
    const idC1 = randomUUID();
    const idC2 = randomUUID();
    await rig.contribuicaoRepository.save({
      id: idC1 as never,
      idCampanha: rig.idCampanha as never,
      idOpcaoContribuicao: randomUUID() as never,
      nome: 'Berço Montessoriano',
      valor: 4500 as never,
      imagemUrl: '🍼',
      grupo: null,
      criadaEm: new Date(),
    } as never);
    await rig.contribuicaoRepository.save({
      id: idC2 as never,
      idCampanha: rig.idCampanha as never,
      idOpcaoContribuicao: randomUUID() as never,
      nome: 'Carrinho 3 em 1',
      valor: 6000 as never,
      imagemUrl: '🛒',
      grupo: null,
      criadaEm: new Date(),
    } as never);

    const idPag1 = randomUUID();
    const idPag2 = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag1,
        idContribuicao: idC1,
        criadoEm: new Date('2026-06-01T08:00:00Z'),
      }),
    );
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag2,
        idContribuicao: idC2,
        criadoEm: new Date('2026-06-02T08:00:00Z'),
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag1,
        idContribuicao: idC1,
        idCampanha: rig.idCampanha,
      }),
      makeLancamento({
        idPagamento: idPag2,
        idContribuicao: idC2,
        idCampanha: rig.idCampanha,
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });

    const byPag = new Map(result.rows.map((r) => [r.idPagamento, r]));
    expect(byPag.get(idPag1)?.contribuicaoNome).toBe('Berço Montessoriano');
    expect(byPag.get(idPag1)?.contribuicaoImagemUrl).toBe('🍼');
    expect(byPag.get(idPag2)?.contribuicaoNome).toBe('Carrinho 3 em 1');
    expect(byPag.get(idPag2)?.contribuicaoImagemUrl).toBe('🛒');
  });
});

// ────────────────────────────────────────────────────────────────────
//  (F) Solicitado state — derived predicate (aperture-1ut92)
// ────────────────────────────────────────────────────────────────────

describe('recebedor.extrato — solicitado state (aperture-1ut92)', () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('row.liberacao = "solicitado" when idRepasse set + transferidoEm null + canceladoEm null', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        idRepasse: randomUUID(), // claimed by a solicitado repasse
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].liberacao).toBe('solicitado');
  });

  it('precedence: transferidoEm set DOMINATES idRepasse → liberacao=transferido', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        idRepasse: randomUUID(),
        transferidoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    expect(result.rows[0].liberacao).toBe('transferido');
  });

  it('precedence: canceladoEm set DOMINATES even idRepasse + transferidoEm → row hidden (cancelado)', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPag = randomUUID();
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPag,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPag,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        idRepasse: randomUUID(),
        canceladoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: [],
      cursor: null,
      limit: 20,
    });
    // Cancelado rows are filtered out of the extrato view entirely.
    expect(result.rows).toHaveLength(0);
  });

  it('summary: solicitado cents flow into aguardandoAprovacaoCents, NOT saldoDisponivelCents', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPagDisp = randomUUID();
    const idPagSol = randomUUID();

    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagDisp,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
      }),
    );
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagSol,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPagDisp,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 4500,
      }),
      makeLancamento({
        idPagamento: idPagSol,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        amountCents: 3000,
        idRepasse: randomUUID(),
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.summary({
      idCampanha: rig.idCampanha,
    });
    expect(result.saldoDisponivelCents).toBe(4500);
    expect(result.aguardandoAprovacaoCents).toBe(3000);
    expect(result.resgatadoCents).toBe(0);
    // totalRecebido includes both — money is in the system either way.
    expect(result.totalRecebidoCents).toBe(7500);
  });

  it('statusFilters supports "solicitado" filter — narrows to admin-pipeline rows only', async () => {
    const past = new Date('2026-06-01T10:00:00.000Z');
    const idPagDisp = randomUUID();
    const idPagSol = randomUUID();

    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagDisp,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-01T08:00:00.000Z'),
      }),
    );
    await rig.pagamentoRepository.save(
      makePagamento({
        id: idPagSol,
        idContribuicao: rig.idContribuicao,
        availableOn: past,
        criadoEm: new Date('2026-06-02T08:00:00.000Z'),
      }),
    );
    await rig.livroFinanceiroRepository.saveLancamentos([
      makeLancamento({
        idPagamento: idPagDisp,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
      }),
      makeLancamento({
        idPagamento: idPagSol,
        idContribuicao: rig.idContribuicao,
        idCampanha: rig.idCampanha,
        idRepasse: randomUUID(),
      }),
    ]);

    const result = await rig.caller.recebedor.extrato.list({
      idCampanha: rig.idCampanha,
      statusFilters: ['solicitado'],
      cursor: null,
      limit: 20,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].liberacao).toBe('solicitado');
    expect(result.rows[0].idPagamento).toBe(idPagSol);
  });
});
