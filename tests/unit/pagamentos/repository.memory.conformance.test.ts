/**
 * Memory-side conformance consumer for PagamentoRepository.
 *
 * The full contract lives in tests/helpers/pagamento-repository.conformance.ts.
 * This file just wires the memory adapter into the shared rig so the same
 * tests run against both PagamentoRepositoryMemory and
 * PagamentoRepositoryPostgres (the Postgres consumer is at
 * tests/integration/pagamento-repository.postgres.test.ts).
 *
 * Replaces the prior tests/unit/pagamentos/repository.memory.test.ts —
 * which covered the same surface inline but did NOT exercise
 * findByExternalRef / findIdsContribuicoesComPagamentoAprovado /
 * findContribuintesFromLatestAprovadoPagamento, and did not assert on
 * span emission at all (aperture-cf4mi).
 */
import { afterAll } from 'vitest';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describePagamentoRepositoryConformance } from '../../helpers/pagamento-repository.conformance.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describePagamentoRepositoryConformance('Memory', {
  factory: () => new PagamentoRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
  // No resetState needed — factory() returns a fresh PagamentoRepositoryMemory
  // (its internal Map is empty per instance).
});
