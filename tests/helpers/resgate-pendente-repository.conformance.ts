import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import type { ResgatePendenteRepository } from '../../src/adapters/arrecadacao/resgate-pendente-repository.js';
import { makeCampanha } from './campanha-repository.conformance.js';

interface ConformanceOptions {
  factory: () =>
    | ResgatePendenteRepository
    | Promise<ResgatePendenteRepository>
    | {
        resgatePendenteRepository: ResgatePendenteRepository;
        campanhaRepository: CampanhaRepository;
      }
    | Promise<{
        resgatePendenteRepository: ResgatePendenteRepository;
        campanhaRepository: CampanhaRepository;
      }>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeResgatePendenteRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`ResgatePendenteRepository conformance — ${name}`, () => {
    let repo: ResgatePendenteRepository;
    let seedCampanha: (idCampanha: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('resgatePendenteRepository' in built) {
        repo = built.resgatePendenteRepository;
        seedCampanha = async (idCampanha: string) => {
          await built.campanhaRepository.save(makeCampanha({ id: idCampanha }));
        };
      } else {
        repo = built;
        seedCampanha = async () => {};
      }
    });

    it('marcarPendente persists pendente_desde, readable via obterPendenteDesde', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idCampanha, desde, desde);
      expect(await repo.obterPendenteDesde(idCampanha)).toEqual(desde);
    });

    it('obterPendenteDesde returns null when no marker exists', async () => {
      expect(await repo.obterPendenteDesde(randomUUID())).toBeNull();
    });

    it('marcarPendente upserts — a second marca refreshes pendente_desde', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const first = new Date('2026-06-01T12:00:00.000Z');
      const second = new Date('2026-06-10T08:00:00.000Z');
      await repo.marcarPendente(idCampanha, first, first);
      await repo.marcarPendente(idCampanha, second, second);
      expect(await repo.obterPendenteDesde(idCampanha)).toEqual(second);
    });

    it('limparPendente removes the marker (obterPendenteDesde → null)', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idCampanha, desde, desde);
      await repo.limparPendente(idCampanha);
      expect(await repo.obterPendenteDesde(idCampanha)).toBeNull();
    });

    it('limparPendente is idempotent — no-op when no marker exists', async () => {
      await expect(repo.limparPendente(randomUUID())).resolves.toBeUndefined();
    });

    it('marcarPendente emits db.resgates_pendentes.marcarPendente span', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const desde = new Date('2026-06-01T12:00:00.000Z');
      await repo.marcarPendente(idCampanha, desde, desde);
      const span = options
        .getSpans()
        .find((s) => s.name === 'db.resgates_pendentes.marcarPendente');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}
