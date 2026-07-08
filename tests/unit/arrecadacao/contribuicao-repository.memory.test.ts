import { afterAll, beforeAll } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { describeContribuicaoRepositoryConformance } from '../../helpers/contribuicao-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Memory-adapter conformance run for ContribuicaoRepository (aperture-zrgau).
 *
 * Before this file, the ContribuicaoRepository conformance suite was
 * consumed only by tests/integration/contribuicao-repository.postgres.test.ts.
 * The memory adapter (ContribuicaoRepositoryMemory) was exercised only
 * indirectly through use-case unit tests that happened to wire it in —
 * never directly against the contract. With Plan 0016 Phase 1 adding a
 * `quantidade` field to Contribuicao (aperture-aj8qw), wiring the memory
 * adapter to the same conformance harness ensures the new field is
 * tested symmetrically on both backends: if the memory adapter ever
 * silently drops a field, the parity test catches it.
 *
 * Mirrors tests/unit/campanha-repository.memory.test.ts (the canonical
 * memory-conformance pattern). Memory adapter shares the same span
 * instrumentation as postgres (`db.system: memory`), so the conformance
 * suite's span assertions work against either adapter — the
 * `expectedDbSystem` parameter just tells the suite which value to
 * assert.
 *
 * No FK seeding required for the memory adapter — unlike the Postgres
 * consumer, the memory store has no foreign-key enforcement, so
 * `seedForContribuicao` is omitted (the harness skips it when
 * undefined). This keeps the memory consumer minimal and surfaces any
 * future divergence in contract shape via the harness, not via setup.
 */
const testObs = createTestObservability();

beforeAll(() => {
  // Nothing to spin up — memory adapter needs no resources.
});

afterAll(async () => {
  await testObs.shutdown();
});

describeContribuicaoRepositoryConformance('Memory', {
  factory: () => new ContribuicaoRepositoryMemory(),
  // No resetState — each beforeEach creates a fresh repo via factory.
  // No seedForContribuicao — memory adapter has no FK enforcement.
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
