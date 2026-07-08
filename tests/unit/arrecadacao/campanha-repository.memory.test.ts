import { afterAll, beforeAll } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import {
  createArrecadacaoMemoryRepos,
  saveCampanhaComRecebedorAtivo,
} from '../../helpers/arrecadacao-repos.js';
import { describeCampanhaRepositoryConformance } from '../../helpers/campanha-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Memory-adapter conformance run (added 2026-06-01 with aperture-u2tko).
 *
 * Until now the conformance suite was invoked from the postgres test
 * only — the memory adapter was exercised indirectly through use-case
 * tests and tRPC integration tests. With the 1..N
 * `findCampanhasByAdministrador` shipping (aperture-u2tko), it's worth
 * pinning both adapters to the same suite so the contract is enforced
 * symmetrically. Future port additions also benefit: both adapters
 * automatically pick up new cases without manual mirroring.
 *
 * Memory adapter shares the same span instrumentation as postgres
 * (`db.system: memory`), so the conformance suite's span assertions
 * work against either adapter — the `expectedDbSystem` parameter just
 * tells the suite which value to assert.
 */
const testObs = createTestObservability();

beforeAll(() => {
  // Nothing to spin up — memory adapter needs no resources.
});

afterAll(async () => {
  await testObs.shutdown();
});

// One pair of repos shared across the suite — the conformance harness
// creates a fresh repo per beforeEach via `factory`, which means
// `saveCampanha` needs a way to also write the matching recebedor row.
// We bind a fresh recebedor repository to each campanha repository in
// `factory` and reuse it inside `saveCampanha` via a tiny indirection.
let currentRecebedorRepo: RecebedorRepositoryMemory | null = null;

describeCampanhaRepositoryConformance('Memory', {
  factory: () => {
    const recebedorRepository = new RecebedorRepositoryMemory();
    currentRecebedorRepo = recebedorRepository;
    return new CampanhaRepositoryMemory(recebedorRepository);
  },
  saveCampanha: async (repo, campanha) => {
    // Persists campanha + matching recebedor row when present, mirroring
    // saveCampanhaComRecebedorAtivo's contract so the conformance
    // suite's findById/findByPlataforma assertions see the same
    // recebedor-hydrated shape they see against postgres.
    if (currentRecebedorRepo === null) {
      throw new Error('saveCampanha called before factory ran — recebedor repo missing.');
    }
    const repos = {
      ...createArrecadacaoMemoryRepos(),
      campanhaRepository: repo,
      recebedorRepository: currentRecebedorRepo,
    };
    await saveCampanhaComRecebedorAtivo(repos, campanha);
  },
  // No resetState — each beforeEach creates a fresh repo via factory.
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
