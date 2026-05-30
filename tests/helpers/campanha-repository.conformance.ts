import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import type { Campanha } from '../../src/domain/arrecadacao/entities/campanha.js';
import { saveCampanhaComRecebedorAtivo } from './arrecadacao-repos.js';

interface ConformanceOptions {
  factory: () => CampanhaRepository | Promise<CampanhaRepository>;
  saveCampanha: (repo: CampanhaRepository, campanha: Campanha) => Promise<void>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeCampanhaRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`CampanhaRepository conformance — ${name}`, () => {
    let repo: CampanhaRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    it('saves and finds a campaign by ID', async () => {
      const campanha = makeCampanha();
      await options.saveCampanha(repo, campanha);

      const found = await repo.findById(campanha.id);
      expect(found).toEqual(campanha);
    });

    it('returns undefined for non-existent ID', async () => {
      const found = await repo.findById(randomUUID());
      expect(found).toBeUndefined();
    });

    it('round-trips campaign with administrators and options', async () => {
      const campanha = makeCampanha({
        idsAdministradores: [randomUUID(), randomUUID()],
        opcoes: [
          { id: randomUUID(), tipo: 'presente' },
          { id: randomUUID(), tipo: 'rifa' },
        ],
      });
      await options.saveCampanha(repo, campanha);
      const found = await repo.findById(campanha.id);
      expect(found).toEqual(campanha);
    });

    it('save emits db.arrecadacao_campanhas.save span', async () => {
      await options.saveCampanha(repo, makeCampanha());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_campanhas.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('UPSERT');
    });

    it('findById emits db.arrecadacao_campanhas.findById span', async () => {
      await repo.findById(randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_campanhas.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('findByPlataforma returns only campaigns belonging to the given plataforma', async () => {
      const idPlataformaA = randomUUID();
      const idPlataformaB = randomUUID();

      const campanhaA1 = makeCampanha({ idPlataforma: idPlataformaA });
      const campanhaA2 = makeCampanha({ idPlataforma: idPlataformaA });
      const campanhaB1 = makeCampanha({ idPlataforma: idPlataformaB });

      await options.saveCampanha(repo, campanhaA1);
      await options.saveCampanha(repo, campanhaA2);
      await options.saveCampanha(repo, campanhaB1);

      const foundForA = await repo.findByPlataforma(idPlataformaA);
      const idsForA = foundForA.map((c) => c.id).sort();
      expect(idsForA).toEqual([campanhaA1.id, campanhaA2.id].sort());

      const foundForB = await repo.findByPlataforma(idPlataformaB);
      expect(foundForB.map((c) => c.id)).toEqual([campanhaB1.id]);
    });

    it('findByPlataforma returns empty array when no campaigns match', async () => {
      const found = await repo.findByPlataforma(randomUUID());
      expect(found).toEqual([]);
    });

    it('findByPlataforma emits db.arrecadacao_campanhas.findByPlataforma span', async () => {
      await repo.findByPlataforma(randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_campanhas.findByPlataforma');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('round-trips a campaign WITHOUT Recebedor (pre-bank-info lifecycle)', async () => {
      const campanha = makeCampanhaSemRecebedor();
      await options.saveCampanha(repo, campanha);

      const found = await repo.findById(campanha.id);
      expect(found).toBeDefined();
      expect(found?.idRecebedor).toBeNull();
      expect(found?.dadosRecebedor).toBeNull();
      expect(found?.id).toBe(campanha.id);
      expect(found?.titulo).toBe(campanha.titulo);
      expect(found?.idsAdministradores).toEqual(campanha.idsAdministradores);
    });

    it('findByPlataforma includes campaigns WITHOUT Recebedor', async () => {
      const idPlataforma = randomUUID();
      const comRecebedor = makeCampanha({ idPlataforma });
      const semRecebedor = makeCampanhaSemRecebedor({ idPlataforma });

      await options.saveCampanha(repo, comRecebedor);
      await options.saveCampanha(repo, semRecebedor);

      const found = await repo.findByPlataforma(idPlataforma);
      const ids = found.map((c) => c.id).sort();
      expect(ids).toEqual([comRecebedor.id, semRecebedor.id].sort());

      const noRec = found.find((c) => c.id === semRecebedor.id);
      expect(noRec?.idRecebedor).toBeNull();
      expect(noRec?.dadosRecebedor).toBeNull();
    });
  });
}

export function makeCampanha(overrides: Partial<Campanha> = {}): Campanha {
  const idRecebedor = randomUUID();
  return {
    id: randomUUID(),
    idPlataforma: randomUUID(),
    idsAdministradores: [randomUUID()],
    idRecebedor,
    dadosRecebedor: {
      nomeTitular: 'Maria Silva',
      tipoChavePix: 'email',
      chavePix: 'maria@exemplo.com',
    },
    titulo: 'Campanha teste',
    opcoes: [],
    criadaEm: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  };
}

/** Builds a Campanha in the post-66klh "pre-bank-info" lifecycle state. */
export function makeCampanhaSemRecebedor(overrides: Partial<Campanha> = {}): Campanha {
  return {
    id: randomUUID(),
    idPlataforma: randomUUID(),
    idsAdministradores: [randomUUID()],
    idRecebedor: null,
    dadosRecebedor: null,
    titulo: 'Campanha sem recebedor',
    opcoes: [],
    criadaEm: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  };
}

/** Conformance em memória: campanha já embute recebedor ativo. */
export function saveCampanhaMemory(repo: CampanhaRepository, campanha: Campanha): Promise<void> {
  return repo.save(campanha);
}

/** Conformance Postgres: persiste também a linha em `recebedores`. */
export async function saveCampanhaPostgres(
  repos: ReturnType<typeof import('./arrecadacao-repos.js').createArrecadacaoMemoryRepos> & {
    campanhaRepository: CampanhaRepository;
  },
  campanha: Campanha,
): Promise<void> {
  await saveCampanhaComRecebedorAtivo(repos, campanha);
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
