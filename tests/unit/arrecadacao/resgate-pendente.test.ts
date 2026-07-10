import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ResgatePendenteRepositoryMemory } from '../../../src/adapters/arrecadacao/resgate-pendente-repository.memory.js';
import { marcarResgatePendente } from '../../../src/use-cases/arrecadacao/marcar-resgate-pendente.js';
import { obterResgatePendente } from '../../../src/use-cases/arrecadacao/obter-resgate-pendente.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describeResgatePendenteRepositoryConformance } from '../../helpers/resgate-pendente-repository.conformance.js';

const testObs = createTestObservability();
const silentObs = testObs.observability;

afterAll(async () => {
  await testObs.shutdown();
});

describe('marcarResgatePendente', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('sets the pending marker (readable via obterResgatePendente)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    const idCampanha = randomUUID();
    const { pendenteDesde } = await marcarResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs, clock },
      { idCampanha },
    );
    expect(pendenteDesde).toEqual(clock());
    const found = await obterResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs },
      idCampanha,
    );
    expect(found).toEqual(clock());
  });

  it('rejects an invalid idCampanha (ArrecadacaoInputInvalidoError)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    await expect(
      marcarResgatePendente(
        { resgatePendenteRepository: repo, observability: silentObs, clock },
        { idCampanha: 'not-a-uuid' },
      ),
    ).rejects.toThrow('Input de arrecadacao invalido');
  });
});

describeResgatePendenteRepositoryConformance('Memory', {
  factory: () => new ResgatePendenteRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
