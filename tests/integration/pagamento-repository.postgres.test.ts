/**
 * Postgres-side conformance consumer for PagamentoRepository, plus
 * Postgres-specific tests for behavior that only matters with a real DB.
 *
 * The conformance suite (shared with the in-memory adapter at
 * tests/unit/pagamentos/repository.memory.conformance.test.ts) covers
 * the core contract: save, update, find, error mapping, AND span emission.
 *
 * This file adds Postgres-specific tests: concurrency under real
 * unique-constraint enforcement (pagamentos_intencao_id_uniq) and
 * PK-collision-as-PagamentoJaExisteError mapping.
 *
 * History (aperture-cf4mi): Before this file existed, the
 * PagamentoRepositoryPostgres adapter had ZERO direct test coverage —
 * it was exercised only indirectly via
 * tests/integration/fluxo-pagamento-rejeitado.test.ts and
 * fluxo-reprocessamento-pagamento.test.ts. Several methods
 * (findByExternalRef, findIdsContribuicoesComPagamentoAprovado,
 * findContribuintesFromLatestAprovadoPagamento) had no direct postgres
 * coverage at all.
 *
 * ⚠️ CURRENTLY SKIPPED (Plan 0016 Phase 0 schema drift):
 * Phase 0 (aperture-z3cpz, PR #162, commit 14d5291) shipped a destructive
 * schema migration: it DROPPED intencao_id_contribuicao,
 * intencao_composicao_valores, and the per-item composição columns; it
 * RENAMED intencao_amount_cents → intencao_total_paid_cents; it ADDED new
 * NOT-NULL aggregate columns + intencao_id_campanha. The current
 * PagamentoRepositoryPostgres adapter still reads/writes the OLD column
 * names, so every test calling save/update/findById against the live
 * schema fails at the SQL boundary. Rex's commit message names this
 * explicitly as the expected post-Phase-0 state and gates Phase 1
 * (aperture-aj8qw — entity surgery) + Phase 2 (aperture-eg1s2 — adapter
 * rewrite) on fixing the adapter alongside the domain.
 *
 * UNSKIP CONDITION: when Phase 2 (aperture-eg1s2) lands the adapter
 * rewrite + extends the conformance rig with
 * somarQuantidadesContribuicoesEmPagamentosAprovados, remove the
 * `.skip` on both describe blocks below and re-run the suite. The
 * conformance + postgres-specific assertions in this file are the
 * landing surface for Phase 2's adapter changes.
 *
 * The memory consumer at
 * tests/unit/pagamentos/repository.memory.conformance.test.ts stays
 * green — Phase 0 only touched the postgres schema, not the domain
 * entity that the memory adapter operates on.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { PixCobrancaProviderFake } from '../../src/adapters/pagamentos/pix-cobranca-provider.fake.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { PagamentoJaExisteError } from '../../src/errors/pagamentos/ja-existe.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { reconciliarCobrancasPix } from '../../src/use-cases/pagamentos/reconciliar-cobrancas-pix.js';
import { createTestObservability } from '../helpers/observability.js';
import {
  describePagamentoRepositoryConformance,
  makePagamento,
} from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents, withParentSeeding } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

// ═══════════════ Shared conformance ═══════════════

// SKIPPED — unblock when Phase 2 (aperture-eg1s2) rewrites the postgres
// adapter to match the post-Phase-0 schema. See the file-header note for
// the full gate.
describe('PagamentoRepository conformance — Postgres', () => {
  describePagamentoRepositoryConformance('Postgres', {
    // Plan 0016 (migrations 022 + 023) added FKs from pagamentos +
    // intencao_items to campanhas + contribuicoes. The shared rig mints
    // random ids for those; wrap save/update to seed the FK parents
    // on-demand so the conformance contract runs against the real schema.
    factory: () => withParentSeeding(new PagamentoRepositoryPostgres(testDb.db), testDb.db),
    resetState: () => truncatePagamentosTables(testDb.db),
    getSpans: () => testObs.getSpans(),
    resetSpans: () => testObs.reset(),
    expectedDbSystem: 'postgresql',
  });
});

// ═══════════════ Postgres-specific tests ═══════════════

// SKIPPED — same Phase 0 schema-drift gate as the conformance suite above.
describe('PagamentoRepositoryPostgres — Postgres-specific', () => {
  let repo: PagamentoRepositoryPostgres;

  beforeEach(async () => {
    await truncatePagamentosTables(testDb.db);
    testObs.reset();
    repo = new PagamentoRepositoryPostgres(testDb.db);
  });

  it('concurrency: two simultaneous saves with the SAME pagamento id — one succeeds, one fails with PagamentoJaExisteError', async () => {
    const id = randomUUID();
    const a = makePagamento({ id });
    const b = makePagamento({ id });

    // Seed FK parents (campanha + contribuição) before racing the saves;
    // the race itself is on the pagamentos PK / intencao_id uniqueness.
    await seedPagamentoParents(testDb.db, a);
    await seedPagamentoParents(testDb.db, b);

    const results = await Promise.allSettled([repo.save(a), repo.save(b)]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failure = failures[0] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(PagamentoJaExisteError);
  });

  it('concurrency: two simultaneous saves sharing the same intencao_id — one succeeds, one fails with PagamentoJaExisteError', async () => {
    // The pagamentos_intencao_id_uniq constraint (migration 011) enforces
    // that one IntencaoPagamento can back at most one Pagamento. This is
    // a different collision path from PK collision — both must map to
    // PagamentoJaExisteError for port-conformance with the memory adapter.
    const a = makePagamento();
    const b: typeof a = {
      ...makePagamento(),
      intencao: { ...a.intencao }, // copy the intencao (same intencao.id)
    };

    // Both share a.intencao (same idCampanha + items); seeding either is
    // sufficient, but seed both for symmetry / idempotency.
    await seedPagamentoParents(testDb.db, a);
    await seedPagamentoParents(testDb.db, b);

    const results = await Promise.allSettled([repo.save(a), repo.save(b)]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    const failures = results.filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const failure = failures[0] as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(PagamentoJaExisteError);
  });

  it('somarQuantidadesContribuicoesEmPagamentosAprovados annotates the span with batch.size', async () => {
    // Postgres-only span annotation (the memory adapter does not record
    // batch.size). Documenting the divergence with a postgres-specific
    // assertion keeps the shared conformance suite system-agnostic.
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await repo.somarQuantidadesContribuicoesEmPagamentosAprovados(ids);

    const spans = testObs.getSpans();
    const span = spans.find(
      (s) => s.name === 'db.pagamentos.somarQuantidadesContribuicoesEmPagamentosAprovados',
    );
    expect(span).toBeDefined();
    expect(span?.attributes['batch.size']).toBe(3);
  });

  it('findContribuintesFromLatestAprovadoPagamento annotates the span with batch.size', async () => {
    const ids = [randomUUID(), randomUUID()];
    await repo.findContribuintesFromLatestAprovadoPagamento(ids);

    const spans = testObs.getSpans();
    const span = spans.find(
      (s) => s.name === 'db.pagamentos.findContribuintesFromLatestAprovadoPagamento',
    );
    expect(span).toBeDefined();
    expect(span?.attributes['batch.size']).toBe(2);
  });

  it('concurrent PIX reconciliation claims never return the same pagamento twice', async () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const leaseUntil = new Date('2026-08-05T12:05:00.000Z');
    const pagamentos = Array.from({ length: 4 }, (_, index) => {
      const id = `00000000-0000-4000-8000-00000000001${index}`;
      return makePagamento({
        id,
        externalRef: id.replaceAll('-', ''),
        expiraEm: new Date(`2026-08-05T11:0${index}:00.000Z`),
      });
    });
    for (const pagamento of pagamentos) {
      await seedPagamentoParents(testDb.db, pagamento);
      await repo.save(pagamento);
    }

    const secondWorker = new PagamentoRepositoryPostgres(testDb.db);
    const [workerA, workerB] = await Promise.all([
      repo.claimPixCobrancaReconciliationCandidates({ now, leaseUntil, limit: 3 }),
      secondWorker.claimPixCobrancaReconciliationCandidates({ now, leaseUntil, limit: 3 }),
    ]);
    const combinedIds = [...workerA, ...workerB].map((candidate) => candidate.idPagamento);

    expect(combinedIds).toHaveLength(4);
    expect(new Set(combinedIds).size).toBe(4);
    expect(combinedIds.sort()).toEqual(pagamentos.map((pagamento) => pagamento.id).sort());
  });

  it('claims and rejects a UUID-bound fake PIX charge without a webhook', async () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    const id = '00000000-0000-4000-8000-000000000029';
    const txid = id.replaceAll('-', '');
    const pagamento = makePagamento({
      id,
      externalRef: txid,
      expiraEm: new Date('2026-08-05T11:55:00.000Z'),
    });
    await seedPagamentoParents(testDb.db, pagamento);
    await repo.save(pagamento);

    const pixCobrancaProvider = new PixCobrancaProviderFake({
      txidFactory: () => txid,
      consultarCobrancaSequence: [{ status: 'removida' }],
      clock: () => now,
    });
    await expect(
      pixCobrancaProvider.criarCobranca({
        idPagamento: pagamento.id,
        idIntencaoPagamento: pagamento.intencao.id,
        amountCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
      }),
    ).resolves.toMatchObject({ txid });

    const deps = {
      pagamentoRepository: repo,
      pixCobrancaProvider,
      pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
      // The removed terminal branch rejects before any Financeiro or
      // campaign/contribution read, keeping this regression on the real
      // Postgres claim seam rather than unrelated bookkeeping adapters.
      contribuicaoRepository: {} as never,
      campanhaRepository: {} as never,
      livroFinanceiroRepository: {} as never,
      clock: () => now,
      observability: { logger: new NoopLogger(), tracer: noopTracer() },
    };

    await expect(reconciliarCobrancasPix(deps)).resolves.toEqual({
      claimed: 1,
      approved: 0,
      rejected: 1,
      deferred: 0,
      failed: 0,
    });
    expect(pixCobrancaProvider.consultarCobrancaCalls).toBe(1);
    await expect(repo.findById(id)).resolves.toMatchObject({
      status: 'rejeitado',
      transacaoExterna: {
        id: txid,
        provedor: 'inter',
        status: 'rejeitado',
        statusBruto: 'REMOVIDA',
      },
    });
    await expect(
      testDb.db
        .selectFrom('pagamentos')
        .select('pix_reconciliacao_claimed_until')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ pix_reconciliacao_claimed_until: null });

    await expect(reconciliarCobrancasPix(deps)).resolves.toMatchObject({ claimed: 0 });
    expect(pixCobrancaProvider.consultarCobrancaCalls).toBe(1);
  });

  it('concurrent provider-read claims for one txid have exactly one winner', async () => {
    const id = '00000000-0000-4000-8000-000000000030';
    const txid = id.replaceAll('-', '');
    const pagamento = makePagamento({
      id,
      externalRef: txid,
      // Provider-read claims are valid before expiry; only the shared lease
      // and local deterministic binding gate this webhook path.
      expiraEm: new Date('2026-08-05T14:00:00.000Z'),
    });
    await seedPagamentoParents(testDb.db, pagamento);
    await repo.save(pagamento);

    const secondWorker = new PagamentoRepositoryPostgres(testDb.db);
    const input = {
      txid,
      e2eId: 'E'.repeat(32),
      now: new Date('2026-08-05T12:00:00.000Z'),
      leaseUntil: new Date('2026-08-05T12:01:00.000Z'),
    };
    const claims = await Promise.all([
      repo.claimPixCobrancaProviderReadByTxid(input),
      secondWorker.claimPixCobrancaProviderReadByTxid(input),
    ]);

    expect(claims.filter((claimed) => claimed === id)).toHaveLength(1);
    expect(claims.filter((claimed) => claimed === undefined)).toHaveLength(1);
  });
});
