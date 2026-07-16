import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { ResgatePendenteRepositoryMemory } from '../../../src/adapters/arrecadacao/resgate-pendente-repository.memory.js';
import { criarRecebedorInicial } from '../../../src/domain/arrecadacao/entities/recebedor.js';
import { marcarResgatePendente } from '../../../src/use-cases/arrecadacao/marcar-resgate-pendente.js';
import { obterResgatePendente } from '../../../src/use-cases/arrecadacao/obter-resgate-pendente.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describeResgatePendenteRepositoryConformance } from '../../helpers/resgate-pendente-repository.conformance.js';

const testObs = createTestObservability();
const silentObs = testObs.observability;

afterAll(async () => {
  await testObs.shutdown();
});

/** An empty recebedor repo — the campanha has NO receiving data (deferred). */
function semRecebedor(): RecebedorRepositoryMemory {
  return new RecebedorRepositoryMemory();
}

/** A recebedor repo where the campanha has ACTIVE bank data saved. */
async function comRecebedorAtivo(idCampanha: string): Promise<RecebedorRepositoryMemory> {
  const repo = new RecebedorRepositoryMemory();
  await repo.save(
    criarRecebedorInicial({
      id: randomUUID(),
      idCampanha,
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Thacy',
        cpfTitular: '52998224725',
        tipoChavePix: 'email',
        chavePix: 'thacy@exemplo.com',
      },
      criadaEm: new Date('2026-06-14T00:00:00.000Z'),
    }),
  );
  return repo;
}

describe('marcarResgatePendente', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('sets the pending marker (readable via obterResgatePendente when no bank data yet)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    const idCampanha = randomUUID();
    const { pendenteDesde } = await marcarResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs, clock },
      { idCampanha },
    );
    expect(pendenteDesde).toEqual(clock());
    const found = await obterResgatePendente(
      {
        resgatePendenteRepository: repo,
        recebedorRepository: semRecebedor(),
        observability: silentObs,
      },
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

describe('obterResgatePendente — stale-marker suppression (aperture-4du7r)', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('SUPPRESSES a marker when the campanha already has an active recebedor (the false banner)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    const idCampanha = randomUUID();
    // A marker exists (e.g. left over / seed), but bank data is complete.
    await marcarResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs, clock },
      { idCampanha },
    );

    const found = await obterResgatePendente(
      {
        resgatePendenteRepository: repo,
        recebedorRepository: await comRecebedorAtivo(idCampanha),
        observability: silentObs,
      },
      idCampanha,
    );
    // Data complete → stale marker suppressed → no false "complete seus dados".
    expect(found).toBeNull();
  });

  it('STILL shows the marker when the campanha has no receiving data (genuine defer)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    const idCampanha = randomUUID();
    await marcarResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs, clock },
      { idCampanha },
    );

    const found = await obterResgatePendente(
      {
        resgatePendenteRepository: repo,
        recebedorRepository: semRecebedor(), // no active recebedor
        observability: silentObs,
      },
      idCampanha,
    );
    expect(found).toEqual(clock());
  });

  it('returns null when no marker exists, regardless of recebedor state', async () => {
    const idCampanha = randomUUID();
    const found = await obterResgatePendente(
      {
        resgatePendenteRepository: new ResgatePendenteRepositoryMemory(),
        recebedorRepository: await comRecebedorAtivo(idCampanha),
        observability: silentObs,
      },
      idCampanha,
    );
    expect(found).toBeNull();
  });
});

describeResgatePendenteRepositoryConformance('Memory', {
  factory: () => new ResgatePendenteRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
