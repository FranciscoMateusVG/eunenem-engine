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
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { PagamentoJaExisteError } from '../../src/errors/pagamentos/ja-existe.error.js';
import { createTestObservability } from '../helpers/observability.js';
import {
  describePagamentoRepositoryConformance,
  makePagamento,
} from '../helpers/pagamento-repository.conformance.js';
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
    factory: () => new PagamentoRepositoryPostgres(testDb.db),
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
});
