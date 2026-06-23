import { afterAll } from 'vitest';
import { ListaDeConvidadosRepositoryMemory } from '../../../src/adapters/evento/lista-de-convidados-repository.memory.js';
import { describeListaDeConvidadosRepositoryConformance } from '../../helpers/lista-de-convidados-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describeListaDeConvidadosRepositoryConformance('Memory', {
  factory: () => new ListaDeConvidadosRepositoryMemory(),
  saveLista: (repo, listaDeConvidados) => repo.save(listaDeConvidados),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
