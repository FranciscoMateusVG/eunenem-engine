/**
 * aperture-jguar — Integration suite for the automated PIX repasse
 * pipeline (aperture-vvh2j): real Postgres (shared Testcontainers
 * container) + REAL pg-boss + the deterministic fake transfer provider.
 *
 * Spec: docs/superpowers/specs/2026-07-16-inter-repasse-automation-design.md
 * (§3.3 transactional enqueue, §5 end-to-end flow, §6 idempotency, §8 tests).
 *
 * Covers:
 *  1. Transactional enqueue — approve commit ⇒ exactly one `repasse.executar`
 *     job; approve rollback ⇒ zero jobs + FSM untouched; re-approve is a
 *     no-op (still one job).
 *  2. Crash-mid-call / re-delivery reconciliation — a re-delivered executar
 *     for a `transferindo` repasse NEVER fires a second pagarPix; it diverts
 *     to `verificando` and schedules `repasse.confirmar`.
 *  3. Races — double-approve (two admins) collapses to one job; concurrent
 *     executar collapses to one pagarPix + one attempt row.
 *  4. Worker lifecycle end-to-end — handlers registered exactly like
 *     apps/eunenem-server/server.tsx (batchSize: 1), driven by pg-boss
 *     polling against the shared container. Includes empirical evidence for
 *     recon Gap C (pg-boss default retry policy on `createQueue` with no
 *     options — retryLimit 2 / retryDelay 0 / no backoff / expire 900s).
 *
 * pg-boss note: the package is a dependency of apps/eunenem-server (own
 * lockfile, NOT hoisted to the repo root), so this file imports the runtime
 * class through the server app's node_modules — the same physical package
 * (and the same .d.ts) that `server.tsx` and the enqueuer adapter resolve.
 */

import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages -- pg-boss lives only in the server app's lockfile; see header.
import { PgBoss } from '../../apps/eunenem-server/node_modules/pg-boss/dist/index.js';
import { RepasseJobEnqueuerPgBoss } from '../../apps/eunenem-server/server/jobs/repasse-enqueuer.pgboss.js';
import type { RecebedorRepository } from '../../src/adapters/arrecadacao/recebedor-repository.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import {
  REPASSE_CONFIRMAR_QUEUE,
  REPASSE_EXECUTAR_QUEUE,
  type RepasseConfirmarJobData,
  type RepasseExecutarJobData,
  type RepasseJobEnqueuer,
} from '../../src/adapters/pagamentos/transferencia-enqueuer.js';
import { TransferenciaProviderFake } from '../../src/adapters/pagamentos/transferencia-provider.fake.js';
import type {
  BuscarPagamentosInput,
  ConsultarPagamentoResult,
  PagamentoEncontrado,
  PagarPixInput,
  PagarPixOutcome,
  TransferenciaProvider,
} from '../../src/adapters/pagamentos/transferencia-provider.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { IdRepasse } from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { gerarTransferReferencia } from '../../src/use-cases/pagamentos/financeiro/aprovar-repasse-recebedor.js';
import { confirmarTransferenciaRepasse } from '../../src/use-cases/pagamentos/financeiro/confirmar-transferencia-repasse.js';
import {
  CONFIRMAR_DELAY_INICIAL_SEGUNDOS,
  executarTransferenciaRepasse,
  MAX_TENTATIVAS_TRANSITORIAS,
} from '../../src/use-cases/pagamentos/financeiro/executar-transferencia-repasse.js';
import { seedLancamentoParents } from '../helpers/seed-lancamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

// ─────────────────────────────────────────────────────────────────────
// Shared rig
// ─────────────────────────────────────────────────────────────────────

const T0 = new Date('2026-07-16T12:00:00Z');

const PIX_RECEBEDOR = {
  metodo: 'pix',
  nomeTitular: 'Bia Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email',
  chavePix: 'bia@example.com',
} as const;

let testDb: TestDatabase;
let repo: LivroFinanceiroRepositoryPostgres;
/** Enqueue-only pg-boss instance — no work() registered, so jobs it sends stay queryable. */
let boss: PgBoss;
let enqueuer: RepasseJobEnqueuerPgBoss;

const observability: Observability = {
  logger: new NoopLogger(),
  tracer: trace.getTracer('jguar-test'),
};

/** Stub RecebedorRepository — every campanha resolves to the active pix recebedor above. */
const recebedorRepositoryStub = {
  async save(): Promise<void> {
    /* not exercised */
  },
  async findAtivoByCampanhaId(): Promise<unknown> {
    return { dadosRecebedor: PIX_RECEBEDOR };
  },
  async findByCampanhaId(): Promise<readonly unknown[]> {
    return [];
  },
} as unknown as RecebedorRepository;

beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new LivroFinanceiroRepositoryPostgres(testDb.db, recebedorRepositoryStub);

  boss = new PgBoss(testDb.connectionUri);
  boss.on('error', () => {
    /* keep background maintenance errors from crashing the run */
  });
  await boss.start();
  // Mirrors server.tsx boot: queues created with NO options (defaults).
  await boss.createQueue(REPASSE_EXECUTAR_QUEUE);
  await boss.createQueue(REPASSE_CONFIRMAR_QUEUE);
  enqueuer = new RepasseJobEnqueuerPgBoss(boss);
}, 60000);

afterAll(async () => {
  await boss.stop({ graceful: false, wait: true, timeout: 5000 });
  // Leave the shared container clean for the next test file — leftover
  // repasse_transfer_attempts rows would 23503 any later file that
  // deletes repasses_recebedor in its own beforeEach.
  await cleanTables();
  await testDb.teardown();
});

async function cleanTables(): Promise<void> {
  const db = testDb.db;
  await sql`DELETE FROM repasse_transfer_attempts`.execute(db);
  await sql`DELETE FROM lancamentos_financeiros`.execute(db);
  await sql`DELETE FROM repasses_recebedor`.execute(db);
  await sql`DELETE FROM intencao_items`.execute(db);
  await sql`DELETE FROM pagamentos`.execute(db);
  await sql`DELETE FROM pgboss.job`.execute(db);
}

beforeEach(async () => {
  await cleanTables();
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 12_000,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

function makeRepasseSolicitado(args: {
  id: string;
  idCampanha: string;
  amountCents?: number;
}): RepasseRecebedor {
  return {
    id: args.id as IdRepasse,
    idCampanha: args.idCampanha as IdCampanha,
    amountCents: (args.amountCents ?? 4500) as never,
    status: 'solicitado',
    solicitadoEm: T0,
    aprovadoEm: null,
    bankTransferRef: null,
    transferReferencia: null,
    interCodigoSolicitacao: null,
    transferAttempts: 0,
    lastTransferError: null,
  };
}

async function seedRepasseSolicitado(args: {
  idCampanha?: string;
  amountCents?: number;
}): Promise<{ idRepasse: IdRepasse; idCampanha: string }> {
  const idRepasse = randomUUID();
  const idCampanha = args.idCampanha ?? randomUUID();
  await repo.saveRepasse(
    makeRepasseSolicitado({ id: idRepasse, idCampanha, amountCents: args.amountCents }),
  );
  return { idRepasse: idRepasse as IdRepasse, idCampanha };
}

/** Seeds a claimed `credito_saldo_recebedor` lançamento (id_repasse set) with its full FK parent chain. */
async function seedClaimedLancamento(args: {
  idCampanha: string;
  idRepasse: string;
  amountCents?: number;
}): Promise<string> {
  const lancamento: LancamentoFinanceiro = {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idItemPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: args.idCampanha as never,
    tipo: 'credito_saldo_recebedor',
    amountCents: (args.amountCents ?? 4500) as never,
    criadoEm: T0,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: args.idRepasse as never,
  };
  await seedLancamentoParents(testDb.db, [lancamento]);
  await repo.saveLancamentos([lancamento]);
  return lancamento.id;
}

/** Mirrors the aprovar-repasse-recebedor use case's pix branch (approve = pay, transactional enqueue). */
async function aprovarPix(
  idRepasse: IdRepasse,
  jobEnqueuer: RepasseJobEnqueuer = enqueuer,
): Promise<{ repasse: RepasseRecebedor }> {
  return repo.aprovarRepassePixTransaction(
    {
      idRepasse,
      aprovadoEm: new Date(),
      transferReferencia: gerarTransferReferencia(idRepasse),
    },
    (executor) => jobEnqueuer.enqueueExecutar({ idRepasse }, executor),
  );
}

interface JobRow {
  id: string;
  state: string;
  data: { idRepasse?: string };
  retry_limit: number;
  retry_count: number;
  delay_seconds: number;
}

async function jobsIn(queue: string): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    SELECT id, state, data, retry_limit, retry_count,
           EXTRACT(EPOCH FROM (start_after - created_on))::float8 AS delay_seconds
      FROM pgboss.job
      WHERE name = ${queue}
      ORDER BY created_on
  `.execute(testDb.db);
  return [...result.rows];
}

interface AttemptRow {
  attempt_no: number;
  referencia: string;
  outcome: string | null;
  codigo_solicitacao: string | null;
  error: string | null;
  finished_at: Date | null;
}

async function attemptRows(idRepasse: string): Promise<AttemptRow[]> {
  const result = await sql<AttemptRow>`
    SELECT attempt_no, referencia, outcome, codigo_solicitacao, error, finished_at
      FROM repasse_transfer_attempts
      WHERE repasse_id = ${idRepasse}
      ORDER BY attempt_no, started_at
  `.execute(testDb.db);
  return [...result.rows];
}

async function stampedLancamentoCount(idRepasse: string): Promise<number> {
  const result = await sql<{ cnt: number }>`
    SELECT count(*)::int AS cnt FROM lancamentos_financeiros
      WHERE id_repasse = ${idRepasse} AND transferido_em IS NOT NULL
  `.execute(testDb.db);
  return result.rows[0]?.cnt ?? 0;
}

function makeSpyEnqueuer(): {
  enqueuer: RepasseJobEnqueuer;
  executar: string[];
  confirmar: Array<{ idRepasse: string; tentativa: number; delaySeconds: number }>;
} {
  const executar: string[] = [];
  const confirmar: Array<{ idRepasse: string; tentativa: number; delaySeconds: number }> = [];
  return {
    executar,
    confirmar,
    enqueuer: {
      async enqueueExecutar(data) {
        executar.push(data.idRepasse);
      },
      async enqueueConfirmar(data, delaySeconds) {
        confirmar.push({
          idRepasse: data.idRepasse,
          tentativa: data.tentativaConfirmacao,
          delaySeconds,
        });
      },
    },
  };
}

interface UseCaseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepositoryPostgres;
  readonly transferenciaProvider: TransferenciaProvider;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

function makeDeps(provider: TransferenciaProvider, jobEnqueuer: RepasseJobEnqueuer): UseCaseDeps {
  return {
    livroFinanceiroRepository: repo,
    transferenciaProvider: provider,
    repasseJobEnqueuer: jobEnqueuer,
    clock: () => new Date(),
    observability,
  };
}

/**
 * Delegates each successive `pagarPix` call to the next fake in the script
 * (last one repeats). Lets a pg-boss re-delivery see a DIFFERENT outcome
 * than the first delivery without any sleeping or mutation races.
 */
class ScriptedTransferenciaProvider implements TransferenciaProvider {
  private calls = 0;
  constructor(private readonly script: readonly TransferenciaProviderFake[]) {}

  get pagarPixCalls(): number {
    return this.calls;
  }

  async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    const index = Math.min(this.calls, this.script.length - 1);
    this.calls += 1;
    return (this.script[index] as TransferenciaProviderFake).pagarPix(input);
  }

  async consultarPagamento(codigoSolicitacao: string): Promise<ConsultarPagamentoResult> {
    return (this.script[this.script.length - 1] as TransferenciaProviderFake).consultarPagamento(
      codigoSolicitacao,
    );
  }

  async buscarPagamentos(input: BuscarPagamentosInput): Promise<readonly PagamentoEncontrado[]> {
    return (this.script[this.script.length - 1] as TransferenciaProviderFake).buscarPagamentos(
      input,
    );
  }
}

/** Wraps a provider so `pagarPix` holds for `delayMs` before delegating — opens a race window. */
class SlowTransferenciaProvider implements TransferenciaProvider {
  constructor(
    private readonly inner: TransferenciaProvider,
    private readonly delayMs: number,
  ) {}

  async pagarPix(input: PagarPixInput): Promise<PagarPixOutcome> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.pagarPix(input);
  }

  async consultarPagamento(codigoSolicitacao: string): Promise<ConsultarPagamentoResult> {
    return this.inner.consultarPagamento(codigoSolicitacao);
  }

  async buscarPagamentos(input: BuscarPagamentosInput): Promise<readonly PagamentoEncontrado[]> {
    return this.inner.buscarPagamentos(input);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 1. Transactional enqueue (spec §3.3)
// ─────────────────────────────────────────────────────────────────────

describe('transactional enqueue — approve = pay rides one transaction', () => {
  it('approve commit ⇒ exactly one repasse.executar job + repasse aprovado with transfer_referencia', async () => {
    const { idRepasse } = await seedRepasseSolicitado({});

    const { repasse } = await aprovarPix(idRepasse);

    expect(repasse.status).toBe('aprovado');
    expect(repasse.transferReferencia).toBe(gerarTransferReferencia(idRepasse));

    const jobs = await jobsIn(REPASSE_EXECUTAR_QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('created');
    expect(jobs[0]?.data.idRepasse).toBe(idRepasse);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('aprovado');
    expect(persisted?.transferReferencia).toBe(gerarTransferReferencia(idRepasse));
  });

  it('approve ROLLBACK ⇒ zero jobs and repasse still solicitado (job insert vanishes with the tx)', async () => {
    const { idRepasse } = await seedRepasseSolicitado({});

    await expect(
      repo.aprovarRepassePixTransaction(
        {
          idRepasse,
          aprovadoEm: new Date(),
          transferReferencia: gerarTransferReferencia(idRepasse),
        },
        async (executor) => {
          // The REAL enqueue rides the transaction first…
          await enqueuer.enqueueExecutar({ idRepasse }, executor);
          // …then the transaction is forced to roll back.
          throw new Error('boom-after-enqueue');
        },
      ),
    ).rejects.toThrow('boom-after-enqueue');

    expect(await jobsIn(REPASSE_EXECUTAR_QUEUE)).toHaveLength(0);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('solicitado');
    expect(persisted?.transferReferencia).toBeNull();
    expect(persisted?.aprovadoEm).toBeNull();
  });

  it('re-approve with the same referencia is a no-op ⇒ still exactly one job', async () => {
    const { idRepasse } = await seedRepasseSolicitado({});

    await aprovarPix(idRepasse);
    const second = await aprovarPix(idRepasse);

    expect(second.repasse.status).toBe('aprovado');
    expect(await jobsIn(REPASSE_EXECUTAR_QUEUE)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Crash-mid-call / re-delivery reconciliation (spec §5.3, §6.3-4)
// ─────────────────────────────────────────────────────────────────────

describe('crash-mid-call and re-delivery reconciliation', () => {
  // VERIFIED-FIXED (aperture-oxqlf, Rex PR #8, staging 1cd53c3): the catch
  // block previously detached `finalizarTentativaTransferencia` into a `const`,
  // stripping `this` off the Postgres repository class method so every THROWN
  // pagarPix error crashed with `TypeError: Cannot read properties of undefined
  // (reading 'db')` at livro-repository.postgres.ts instead of the divert/revert
  // logic. This bit the POSTGRES adapter specifically (Rex's memory-fake unit
  // tests use arrow-function literals with no `this`, so they missed it). Rex
  // now calls the method on the repository directly; the ambiguous-throw
  // in-process divert to verificando + confirmar scheduling executes. Flipped
  // it.fails → it() as the in-suite (real-Postgres) regression lock.
  it('ambiguous throw AFTER intent commit diverts to verificando + schedules confirmar (no crash, no double-pay)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    await aprovarPix(idRepasse);

    const fake = new TransferenciaProviderFake({ pagarPixOutcome: 'ambiguo' });
    const spy = makeSpyEnqueuer();

    // Post-oxqlf-fix: this resolves (no throw), diverting to verificando.
    await executarTransferenciaRepasse(makeDeps(fake, spy.enqueuer), { idRepasse });

    expect(fake.pagarPixCalls).toBe(1);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('verificando');
    expect(persisted?.interCodigoSolicitacao).toBeNull();

    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('verificando');
    expect(attempts[0]?.finished_at).not.toBeNull();

    expect(spy.confirmar).toEqual([
      { idRepasse, tentativa: 1, delaySeconds: CONFIRMAR_DELAY_INICIAL_SEGUNDOS },
    ]);
    // No money marked as moved while ambiguous.
    expect(await stampedLancamentoCount(idRepasse)).toBe(0);
  });

  it('hard crash after claim ⇒ re-delivered executar NEVER fires a second pagarPix (acao reconciliar)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    await aprovarPix(idRepasse);

    // Simulate the worker dying mid-call: claim committed (transferindo +
    // open intent row) but no pagarPix outcome ever recorded.
    const claimed = await repo.iniciarTransferenciaTransaction({
      idRepasse,
      requestSummary: 'crash-simulation',
      agora: new Date(),
    });
    expect(claimed.acao).toBe('prosseguir');
    expect(claimed.repasse.status).toBe('transferindo');

    // pg-boss re-delivery: a FRESH provider that WOULD pay if wrongly invoked.
    const freshFake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    const spy = makeSpyEnqueuer();

    await executarTransferenciaRepasse(makeDeps(freshFake, spy.enqueuer), { idRepasse });

    // THE invariant: re-delivery never fires a second pagarPix.
    expect(freshFake.pagarPixCalls).toBe(0);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('verificando');

    // Still a single attempt row — the open intent was closed as verificando,
    // no new attempt was opened.
    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt_no).toBe(1);
    expect(attempts[0]?.outcome).toBe('verificando');

    expect(spy.confirmar).toEqual([
      { idRepasse, tentativa: 1, delaySeconds: CONFIRMAR_DELAY_INICIAL_SEGUNDOS },
    ]);
    expect(await stampedLancamentoCount(idRepasse)).toBe(0);
  });

  // VERIFIED-FIXED (resolver 23505, Rex PR #8, livro-repository.postgres.ts:1152-1168):
  // resolverVerificacaoTransferencia previously INSERTed its reconciliation
  // audit row with attempt_no = transferAttempts, colliding with the already-
  // closed executar attempt row under UNIQUE (repasse_id, attempt_no) (23505),
  // so the resolver txn rolled back and confirmar threw — meaning NO verificando
  // repasse could EVER resolve (the whole reconcile path was dead on Postgres).
  // Rex now UPDATEs the existing verificando row instead of inserting a colliding
  // one (and cancelarRepasse uses MAX(attempt_no)+1 at :1238 for the sibling gap).
  // This is a POSTGRES-only fix — the memory adapter never had the collision, so
  // it needs a real-Postgres regression lock. Flipped it.fails → it().
  //
  // NB (s8v26): the search hit MUST carry the repasse's referencia — Rex's
  // strong-key match (p.referencia === repasse.transferReferencia) is what makes
  // buscarPagamentos safe. Without it, this test would stay `verificando` and
  // never reach the resolver at all, masking the fix.
  it('reconciliation via buscarPagamentos resolves a codigo-less verificando to pago (no 23505 on the audit insert)', async () => {
    const amountCents = 4500;
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({ amountCents });
    await seedClaimedLancamento({ idCampanha, idRepasse, amountCents });
    await aprovarPix(idRepasse);
    const referencia = gerarTransferReferencia(idRepasse);

    // Crash shape: verificando with NO codigoSolicitacao captured. Driven
    // through the repository primitives (the executar catch path that would
    // produce this in-process is separately covered by the ambiguous-throw
    // divert test above).
    const claimed = await repo.iniciarTransferenciaTransaction({
      idRepasse,
      requestSummary: 'test-setup',
      agora: new Date(),
    });
    await repo.finalizarTentativaTransferencia({
      idRepasse,
      attemptId: claimed.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: null },
      agora: new Date(),
    });

    // Confirmar reconciles by searching Inter's history and adopting the match
    // (referencia-strong-keyed, per s8v26 fix).
    const reconciler = new TransferenciaProviderFake({
      buscarResultados: [
        {
          codigoSolicitacao: 'inter_recovered_123',
          valorCents: amountCents as never,
          chave: PIX_RECEBEDOR.chavePix,
          referencia,
          status: 'pago',
        },
      ],
      consultSequence: ['pago'],
    });
    const spyConfirm = makeSpyEnqueuer();
    await confirmarTransferenciaRepasse(makeDeps(reconciler, spyConfirm.enqueuer), {
      idRepasse,
      tentativaConfirmacao: 1,
    });

    expect(reconciler.pagarPixCalls).toBe(0); // confirmar NEVER pays

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('pago');
    expect(persisted?.interCodigoSolicitacao).toBe('inter_recovered_123');
    expect(await stampedLancamentoCount(idRepasse)).toBe(1);
  });

  // VERIFIED-FIXED (resolver 23505, Rex PR #8) on the CONSULT path — the common
  // production case (agendado_aprovacao left a codigoSolicitacao behind). Same
  // fix as the buscarPagamentos test above (UPDATE the verificando row rather
  // than INSERT a colliding audit row). Flipped it.fails → it().
  it('confirmar consulting a known codigo as pago resolves the repasse to pago (no 23505 on the audit insert)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    await aprovarPix(idRepasse);

    const claimed = await repo.iniciarTransferenciaTransaction({
      idRepasse,
      requestSummary: 'test-setup',
      agora: new Date(),
    });
    await repo.finalizarTentativaTransferencia({
      idRepasse,
      attemptId: claimed.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: 'inter_known_1' },
      agora: new Date(),
    });

    const fake = new TransferenciaProviderFake({ consultSequence: ['pago'] });
    const spy = makeSpyEnqueuer();
    await confirmarTransferenciaRepasse(makeDeps(fake, spy.enqueuer), {
      idRepasse,
      tentativaConfirmacao: 1,
    });

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('pago');
    expect(fake.pagarPixCalls).toBe(0);
    expect(await stampedLancamentoCount(idRepasse)).toBe(1);
  });

  it('confirmar NEVER calls pagarPix from verificando, even when it cannot resolve (double-pay door stays shut)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    await aprovarPix(idRepasse);

    const claimed = await repo.iniciarTransferenciaTransaction({
      idRepasse,
      requestSummary: 'test-setup',
      agora: new Date(),
    });
    await repo.finalizarTentativaTransferencia({
      idRepasse,
      attemptId: claimed.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: 'inter_pending_1' },
      agora: new Date(),
    });

    // Non-terminal consult status → confirmar must reschedule, not pay.
    const fake = new TransferenciaProviderFake({
      pagarPixOutcome: 'pago',
      consultSequence: ['em_processamento'],
    });
    const spy = makeSpyEnqueuer();
    await confirmarTransferenciaRepasse(makeDeps(fake, spy.enqueuer), {
      idRepasse,
      tentativaConfirmacao: 1,
    });

    expect(fake.pagarPixCalls).toBe(0);
    expect(fake.consultarPagamentoCalls).toBe(1);
    expect(spy.confirmar).toEqual([{ idRepasse, tentativa: 2, delaySeconds: 120 }]);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('verificando');
    expect(await stampedLancamentoCount(idRepasse)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Races (spec §6, §8 — double-approve, double-executar)
// ─────────────────────────────────────────────────────────────────────

describe('races — double-approve and double-executar', () => {
  it('two concurrent approves (two admins) ⇒ aprovado + EXACTLY ONE executar job + single referencia', async () => {
    const { idRepasse } = await seedRepasseSolicitado({});

    const results = await Promise.allSettled([aprovarPix(idRepasse), aprovarPix(idRepasse)]);

    // The FOR UPDATE + same-referencia idempotency should let both fulfill,
    // but the load-bearing assertions are the job count and the FSM.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`unexpected rejection on concurrent approve: ${String(r.reason)}`);
      }
    }

    const jobs = await jobsIn(REPASSE_EXECUTAR_QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.idRepasse).toBe(idRepasse);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('aprovado');
    expect(persisted?.transferReferencia).toBe(gerarTransferReferencia(idRepasse));
  });

  it('two concurrent executar for the same aprovado repasse ⇒ exactly one pagarPix, one attempt row, one stamp', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    await aprovarPix(idRepasse);

    const innerFake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    const slow = new SlowTransferenciaProvider(innerFake, 400);
    const spyA = makeSpyEnqueuer();
    const spyB = makeSpyEnqueuer();

    const results = await Promise.allSettled([
      executarTransferenciaRepasse(makeDeps(slow, spyA.enqueuer), { idRepasse }),
      executarTransferenciaRepasse(makeDeps(slow, spyB.enqueuer), { idRepasse }),
    ]);

    // Core invariant: the provider fired EXACTLY once across both workers.
    expect(innerFake.pagarPixCalls).toBe(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    // UNIQUE (repasse_id, attempt_no) held: a single attempt row, closed once.
    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt_no).toBe(1);

    // The loser either saw `concluido` or diverted to verificando; the payer
    // resolves the repasse to pago (verificando → pago is domain-legal).
    const persisted = await repo.findRepasseById(idRepasse);
    expect(['pago', 'verificando']).toContain(persisted?.status);

    // Never double-stamps: the single seeded lançamento is stamped at most
    // once, and only if the repasse actually reached pago.
    const stamped = await stampedLancamentoCount(idRepasse);
    expect(stamped).toBe(persisted?.status === 'pago' ? 1 : 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Worker lifecycle end-to-end (real pg-boss delivery, server.tsx mirror)
// ─────────────────────────────────────────────────────────────────────

describe('worker lifecycle end-to-end (pg-boss delivers, handlers mirror server.tsx)', () => {
  let workerBoss: PgBoss;
  let workerEnqueuer: RepasseJobEnqueuerPgBoss;
  /** Swapped per test — the registered handlers read through this holder. */
  const providerHolder: { current: TransferenciaProvider } = {
    current: new TransferenciaProviderFake(),
  };

  beforeAll(async () => {
    workerBoss = new PgBoss({
      connectionString: testDb.connectionUri,
      // Tighter idle poll than the 2s default — keeps bounded waits short.
      pollingIntervalSeconds: 0.5,
    });
    workerBoss.on('error', () => {
      /* swallow background errors in tests */
    });
    await workerBoss.start();
    workerEnqueuer = new RepasseJobEnqueuerPgBoss(workerBoss);

    const delegatingProvider: TransferenciaProvider = {
      pagarPix: (input) => providerHolder.current.pagarPix(input),
      consultarPagamento: (codigo) => providerHolder.current.consultarPagamento(codigo),
      buscarPagamentos: (input) => providerHolder.current.buscarPagamentos(input),
    };
    const deps = makeDeps(delegatingProvider, workerEnqueuer);

    // Mirror of apps/eunenem-server/server.tsx — executar with batchSize: 1,
    // confirmar with defaults (queues already created with NO options).
    await workerBoss.work<RepasseExecutarJobData>(
      REPASSE_EXECUTAR_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await executarTransferenciaRepasse(deps, { idRepasse: job.data.idRepasse as IdRepasse });
        }
      },
    );
    await workerBoss.work<RepasseConfirmarJobData>(
      REPASSE_CONFIRMAR_QUEUE,
      { pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) {
          await confirmarTransferenciaRepasse(deps, {
            idRepasse: job.data.idRepasse as IdRepasse,
            tentativaConfirmacao: job.data.tentativaConfirmacao,
          });
        }
      },
    );
  }, 30000);

  afterAll(async () => {
    await workerBoss.stop({ graceful: false, wait: true, timeout: 5000 });
  });

  it('Gap C evidence: createQueue with NO options ⇒ retryLimit 2, retryDelay 0, no backoff, expire 900s', async () => {
    // server.tsx registers queues + workers with no retry configuration at
    // all, so THESE defaults are the production retry policy. Spec §3.3
    // called for retryLimit: 4 — see the IMPL-GAP test below.
    const result = await sql<{
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      expire_seconds: number;
    }>`
      SELECT retry_limit, retry_delay, retry_backoff, expire_seconds
        FROM pgboss.queue WHERE name = ${REPASSE_EXECUTAR_QUEUE}
    `.execute(testDb.db);

    expect(result.rows[0]).toEqual({
      retry_limit: 2,
      retry_delay: 0,
      retry_backoff: false,
      expire_seconds: 900,
    });
  });

  it('happy path: approve → boss delivers executar → pago, transferido_em stamped, attempt closed', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });

    const fake = new TransferenciaProviderFake({ pagarPixOutcome: 'pago' });
    providerHolder.current = fake;

    await aprovarPix(idRepasse, workerEnqueuer);

    await waitFor(
      `repasse ${idRepasse} pago via pg-boss worker`,
      async () => (await repo.findRepasseById(idRepasse))?.status === 'pago',
      10_000,
    );

    expect(fake.pagarPixCalls).toBe(1);

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('pago');
    expect(persisted?.interCodigoSolicitacao).toMatch(/^inter_fake_/);
    expect(persisted?.transferAttempts).toBe(1);

    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('pago');
    expect(attempts[0]?.codigo_solicitacao).toBe(persisted?.interCodigoSolicitacao);
    expect(attempts[0]?.finished_at).not.toBeNull();

    expect(await stampedLancamentoCount(idRepasse)).toBe(1);
  }, 20_000);

  it('agendado_aprovacao: executar → verificando + confirmar job scheduled ≈30s out (NOT success)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });

    const fake = new TransferenciaProviderFake({
      pagarPixOutcome: 'agendado_aprovacao',
      consultSequence: ['pago'],
    });
    providerHolder.current = fake;

    await aprovarPix(idRepasse, workerEnqueuer);

    // Wait for the handler's LAST side-effect (the confirmar enqueue), not just
    // the status write. The agendado_aprovacao branch does two sequential awaits
    // — finalizar(verificando) THEN enqueueConfirmar — so polling on status alone
    // races the enqueue (green in isolation, flaky under full-suite load where
    // the confirmar row isn't committed yet when asserted).
    await waitFor(
      `repasse ${idRepasse} verificando + confirmar enqueued via pg-boss worker`,
      async () => {
        const r = await repo.findRepasseById(idRepasse);
        if (r?.status !== 'verificando') return false;
        return (await jobsIn(REPASSE_CONFIRMAR_QUEUE)).length === 1;
      },
      10_000,
    );

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.interCodigoSolicitacao).toMatch(/^inter_fake_/);
    expect(fake.pagarPixCalls).toBe(1);

    // Inter-side approval is NOT success: nothing stamped, attempt closed as verificando.
    expect(await stampedLancamentoCount(idRepasse)).toBe(0);
    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('verificando');

    // The confirmar job EXISTS with startAfter ≈ 30s — we assert the row,
    // we do NOT wait it out. (The resolution step itself — confirmar
    // consulting `pago` — is exercised in the reconciliation describe.)
    const confirmarJobs = await jobsIn(REPASSE_CONFIRMAR_QUEUE);
    expect(confirmarJobs).toHaveLength(1);
    expect(confirmarJobs[0]?.state).toBe('created');
    expect(confirmarJobs[0]?.data.idRepasse).toBe(idRepasse);
    expect(confirmarJobs[0]?.delay_seconds).toBeGreaterThanOrEqual(29);
    expect(confirmarJobs[0]?.delay_seconds).toBeLessThanOrEqual(31);
  }, 20_000);

  // Gap C empirical evidence, part 2: does a crashed executar job actually
  // re-deliver? YES for a THROWN handler error — pg-boss marks the job `retry`
  // and re-delivers it on the next fetch, up to retryLimit. Post-oxqlf-fix, a
  // TRANSITORIO throw is the ONE safe-to-retry class (TransferenciaTransitoriaError
  // asserts no payment was created): delivery 1 cleanly reverts to `aprovado`
  // and rethrows, so delivery 2 is a FRESH claim carrying the SAME stable
  // referencia that pays. Two pagarPix calls, exactly ONE successful PIX —
  // the double-pay invariant holds because the transitorio attempt moved no money.
  //
  // We enqueue with retryDelay 0 so the single re-delivery is observable inside
  // the test budget; prod uses retryDelay 15 + backoff (EXECUTAR_JOB_OPTIONS),
  // whose values are the contract asserted in the createQueue-defaults test
  // above. A true PROCESS crash (no throw) leaves the job `active` until
  // expireInSeconds lapses — untestable in a short budget.
  it('Gap C: a thrown transitorio IS re-delivered by pg-boss (retry_count 1); the re-delivery is a clean fresh attempt (same referencia) that pays', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    const referencia = gerarTransferReferencia(idRepasse);

    // Delivery 1 throws (transitorio, no payment created); delivery 2 pays.
    const scripted = new ScriptedTransferenciaProvider([
      new TransferenciaProviderFake({ pagarPixOutcome: 'transitorio' }),
      new TransferenciaProviderFake({ pagarPixOutcome: 'pago' }),
    ]);
    providerHolder.current = scripted;

    // Approve (commit) WITHOUT the slow prod enqueue, then send a fast-retry
    // job so the single re-delivery lands inside the budget.
    await aprovarPix(idRepasse, makeSpyEnqueuer().enqueuer);
    await workerBoss.send(
      REPASSE_EXECUTAR_QUEUE,
      { idRepasse },
      { retryLimit: 6, retryDelay: 0, retryBackoff: false },
    );

    // Wait for the JOB to reach `completed` — pg-boss marks completion AFTER
    // the handler returns (i.e. after the pago FSM write commits), so this is
    // the strongest end-of-processing signal and implies status === 'pago'.
    // Polling on status alone would race the job-state assertion below.
    await waitFor(
      'executar job re-delivered and completed as pago',
      async () => (await jobsIn(REPASSE_EXECUTAR_QUEUE))[0]?.state === 'completed',
      12_000,
    );

    const jobs = await jobsIn(REPASSE_EXECUTAR_QUEUE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.retry_count).toBe(1); // re-delivered exactly once
    expect(jobs[0]?.state).toBe('completed');

    // transitorio created NO payment; the retry is a clean fresh attempt.
    // Two pagarPix calls, ONE successful PIX.
    expect(scripted.pagarPixCalls).toBe(2);

    // Both attempts carry the IDENTICAL stable referencia (the idempotency
    // anchor — retries are the SAME payment identity, never a fresh UUID).
    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.referencia)).toEqual([referencia, referencia]);
    expect(attempts[0]?.outcome).toBe('transitorio');
    expect(attempts[1]?.outcome).toBe('pago');

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('pago');
    expect(await stampedLancamentoCount(idRepasse)).toBe(1);
    // pago resolves directly — no reconciliation scheduled.
    expect(await jobsIn(REPASSE_CONFIRMAR_QUEUE)).toHaveLength(0);
  }, 25_000);

  // VERIFIED-FIXED (aperture-vvh2j retry policy, Rex PR #8 —
  // repasse-enqueuer.pgboss.ts EXECUTAR_JOB_OPTIONS): the executar enqueue now
  // carries retryLimit 6 (> MAX_TENTATIVAS_TRANSITORIAS = 4), so pg-boss delivers
  // enough times for the handler's own falhou terminator to fire at attempt 4
  // BEFORE pg-boss gives up. Previously createQueue used the default retryLimit 2
  // (only 3 deliveries) and a persistently-transient repasse stranded in
  // `aprovado` with a dead job and no sweeper. (This composes with the oxqlf fix:
  // the transitorio revert-and-rethrow path itself now runs at all.) We enqueue
  // with retryDelay 0 (prod uses 15 + backoff) so the 4 deliveries land inside
  // the budget; the retryLimit VALUE is the contract under test. Flipped
  // it.fails → it().
  it('persistently transient failure retries cleanly and surfaces as falhou at MAX_TENTATIVAS_TRANSITORIAS (retryLimit 6 > cap 4)', async () => {
    const { idRepasse, idCampanha } = await seedRepasseSolicitado({});
    await seedClaimedLancamento({ idCampanha, idRepasse });
    providerHolder.current = new TransferenciaProviderFake({ pagarPixOutcome: 'transitorio' });

    await aprovarPix(idRepasse, makeSpyEnqueuer().enqueuer);
    await workerBoss.send(
      REPASSE_EXECUTAR_QUEUE,
      { idRepasse },
      { retryLimit: MAX_TENTATIVAS_TRANSITORIAS + 2, retryDelay: 0, retryBackoff: false },
    );

    // After exhausting the transient budget the repasse surfaces as `falhou`.
    await waitFor(
      `repasse ${idRepasse} surfaces as falhou after transient exhaustion`,
      async () => (await repo.findRepasseById(idRepasse))?.status === 'falhou',
      12_000,
    );

    const persisted = await repo.findRepasseById(idRepasse);
    expect(persisted?.status).toBe('falhou');
    expect(persisted?.lastTransferError).toBe('TRANSITORIO_ESGOTADO');

    // Exactly MAX fresh attempts, the last closed as falhou.
    const attempts = await attemptRows(idRepasse);
    expect(attempts).toHaveLength(MAX_TENTATIVAS_TRANSITORIAS);
    expect(attempts.at(-1)?.outcome).toBe('falhou');
    // Money never debited across the whole storm.
    expect(await stampedLancamentoCount(idRepasse)).toBe(0);
  }, 20_000);
});
