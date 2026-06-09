import { afterAll } from 'vitest';
import { ConviteRepositoryMemory } from '../../../src/adapters/evento/convite-repository.memory.js';
import { describeConviteRepositoryConformance } from '../../helpers/convite-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describeConviteRepositoryConformance('Memory', {
  factory: () => new ConviteRepositoryMemory(),
  saveConvite: (repo, convite) => repo.save(convite),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
