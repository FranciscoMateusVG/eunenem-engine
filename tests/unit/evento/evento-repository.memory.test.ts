import { afterAll } from 'vitest';
import { EventoRepositoryMemory } from '../../../src/adapters/evento/evento-repository.memory.js';
import { describeEventoRepositoryConformance } from '../../helpers/evento-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describeEventoRepositoryConformance('Memory', {
  factory: () => new EventoRepositoryMemory(),
  saveEvento: (repo, evento) => repo.save(evento),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
