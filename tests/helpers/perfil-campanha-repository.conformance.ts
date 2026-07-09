import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import type { PerfilCampanhaRepository } from '../../src/adapters/arrecadacao/perfil-campanha-repository.js';
import { criarCampanhaSemRecebedor } from '../../src/domain/arrecadacao/entities/campanha.js';
import {
  criarPerfilCampanha,
  type PerfilCampanha,
} from '../../src/domain/arrecadacao/entities/perfil-campanha.js';
import type { ConteudoPerfilCriador } from '../../src/domain/usuario/value-objects/conteudo-perfil-criador.js';

/**
 * PerfilCampanhaRepository conformance (aperture-aphk8) — mirrors the
 * perfil-criador-repository conformance suite 1:1, with the parent seed
 * being a `campanhas` row (FK id_campanha → campanhas ON DELETE CASCADE)
 * instead of a `usuarios` row.
 */

/** Build a PerfilCampanha for a campanha with the given (partial) content. */
export function makePerfilCampanha(
  idCampanha: string,
  conteudo: ConteudoPerfilCriador,
  criadoEm: Date = new Date('2026-07-01T12:00:00.000Z'),
): PerfilCampanha {
  return criarPerfilCampanha({ id: randomUUID(), idCampanha, conteudo, criadoEm });
}

const CONTEUDO_PREENCHIDO: ConteudoPerfilCriador = {
  nomeBebe: 'Helena',
  relacao: 'Mãe',
  historia: 'Era uma vez uma espera cheia de amor.',
  dataNascimento: new Date('2026-09-15T00:00:00.000Z'),
  tipoEvento: 'cha-bebe',
  genero: 'menina',
  dataEvento: new Date('2026-08-01T00:00:00.000Z'),
  fotoPerfilKey: 'campanha/helena/perfil.jpg',
  fotoCapaKey: 'campanha/helena/capa.jpg',
  fotoHistoriaKey: 'campanha/helena/historia.jpg',
};

const CONTEUDO_ATUALIZADO: ConteudoPerfilCriador = {
  nomeBebe: 'Helena Maria',
  relacao: 'Mãe',
  historia: 'A história atualizada.',
  dataNascimento: new Date('2026-09-16T00:00:00.000Z'),
  tipoEvento: 'cha-revelacao',
  genero: 'surpresa',
  dataEvento: null,
  fotoPerfilKey: null,
  fotoCapaKey: null,
  fotoHistoriaKey: null,
};

interface ConformanceOptions {
  /**
   * Returns the repo under test. For adapters with a real FK to `campanhas`
   * (Postgres), also return a `campanhaRepository` so the suite can seed the
   * parent row before saving a profile. Memory adapters return the bare repo.
   */
  factory: () =>
    | PerfilCampanhaRepository
    | Promise<PerfilCampanhaRepository>
    | { perfilCampanhaRepository: PerfilCampanhaRepository; campanhaRepository: CampanhaRepository }
    | Promise<{
        perfilCampanhaRepository: PerfilCampanhaRepository;
        campanhaRepository: CampanhaRepository;
      }>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describePerfilCampanhaRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`PerfilCampanhaRepository conformance — ${name}`, () => {
    let repo: PerfilCampanhaRepository;
    let seedCampanha: (idCampanha: string) => Promise<void>;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      const built = await options.factory();
      if ('perfilCampanhaRepository' in built) {
        repo = built.perfilCampanhaRepository;
        seedCampanha = async (idCampanha: string) => {
          await built.campanhaRepository.save(
            criarCampanhaSemRecebedor({
              id: idCampanha,
              idPlataforma: randomUUID(),
              idsAdministradores: [],
              titulo: `Campanha ${idCampanha}`,
              opcoes: [],
              criadaEm: new Date('2026-07-01T10:00:00.000Z'),
            }),
          );
        };
      } else {
        repo = built;
        seedCampanha = async () => {};
      }
    });

    it('saves a profile and finds it by campanha id', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const perfil = makePerfilCampanha(idCampanha, CONTEUDO_PREENCHIDO);
      await repo.save(perfil);
      expect(await repo.findByIdCampanha(idCampanha)).toEqual(perfil);
    });

    it('returns undefined when no profile exists for the campanha', async () => {
      expect(await repo.findByIdCampanha(randomUUID())).toBeUndefined();
    });

    it('upsert replaces content and bumps atualizadoEm while preserving id + criadoEm', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const original = makePerfilCampanha(
        idCampanha,
        CONTEUDO_PREENCHIDO,
        new Date('2026-07-01T12:00:00.000Z'),
      );
      await repo.save(original);

      // Second save: new aggregate id + later timestamps + new content.
      const reedit = makePerfilCampanha(
        idCampanha,
        CONTEUDO_ATUALIZADO,
        new Date('2026-07-10T08:00:00.000Z'),
      );
      await repo.save(reedit);

      const found = await repo.findByIdCampanha(idCampanha);
      expect(found).toBeDefined();
      // Identity + creation time are immutable across re-saves (1:1).
      expect(found?.id).toBe(original.id);
      expect(found?.criadoEm).toEqual(original.criadoEm);
      // Content + atualizadoEm reflect the latest save.
      expect(found?.conteudo).toEqual(CONTEUDO_ATUALIZADO);
      expect(found?.atualizadoEm).toEqual(reedit.atualizadoEm);
    });

    it('persists all-null content (empty profile)', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      const vazio: ConteudoPerfilCriador = {
        nomeBebe: null,
        relacao: null,
        historia: null,
        dataNascimento: null,
        tipoEvento: null,
        genero: null,
        dataEvento: null,
        fotoPerfilKey: null,
        fotoCapaKey: null,
        fotoHistoriaKey: null,
      };
      const perfil = makePerfilCampanha(idCampanha, vazio);
      await repo.save(perfil);
      expect(await repo.findByIdCampanha(idCampanha)).toEqual(perfil);
    });

    it('profiles of two campanhas are isolated — writing B never touches A', async () => {
      const idCampanhaA = randomUUID();
      const idCampanhaB = randomUUID();
      await seedCampanha(idCampanhaA);
      await seedCampanha(idCampanhaB);

      const perfilA = makePerfilCampanha(idCampanhaA, CONTEUDO_PREENCHIDO);
      await repo.save(perfilA);
      const perfilB = makePerfilCampanha(idCampanhaB, CONTEUDO_ATUALIZADO);
      await repo.save(perfilB);

      expect(await repo.findByIdCampanha(idCampanhaA)).toEqual(perfilA);
      expect(await repo.findByIdCampanha(idCampanhaB)).toEqual(perfilB);
    });

    it('save emits db.perfil_campanhas.save span', async () => {
      const idCampanha = randomUUID();
      await seedCampanha(idCampanha);
      await repo.save(makePerfilCampanha(idCampanha, CONTEUDO_PREENCHIDO));
      const span = options.getSpans().find((s) => s.name === 'db.perfil_campanhas.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
    });
  });
}
