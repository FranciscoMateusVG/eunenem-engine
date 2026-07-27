import { afterAll } from 'vitest';
import { CatalogoRepositoryMemory } from '../../../src/adapters/catalogo/repository.memory.js';
import { describeCatalogoRepositoryConformance } from '../../helpers/catalogo-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describeCatalogoRepositoryConformance('Memory', {
  factory: () => new CatalogoRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
