import { afterAll } from 'vitest';
import { CampanhaMembrosRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-membros-repository.memory.js';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { describeCampanhaMembrosRepositoryConformance } from '../../helpers/campanha-membros-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const testObs = createTestObservability();

afterAll(async () => {
  await testObs.shutdown();
});

describeCampanhaMembrosRepositoryConformance('Memory', {
  factory: async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    return {
      campanhaMembrosRepository: new CampanhaMembrosRepositoryMemory(campanhaRepository),
      campanhaRepository,
      criarCampanha: (campanha) => campanhaRepository.save(campanha),
      adicionarAdministrador: (idCampanha, idConta) =>
        campanhaRepository.adicionarAdministrador(idCampanha, idConta),
      removerAdministrador: (idCampanha, idConta) =>
        campanhaRepository.removerAdministrador(idCampanha, idConta),
    };
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
