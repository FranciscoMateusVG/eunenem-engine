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

    it('findFirstByAdministrador returns undefined when nothing matches (aperture-p8i01)', async () => {
      const found = await repo.findFirstByAdministrador(randomUUID());
      expect(found).toBeUndefined();
    });

    it('findFirstByAdministrador returns the matching campaign by conta id (aperture-p8i01)', async () => {
      const idConta = randomUUID();
      const campanha = makeCampanha({ idsAdministradores: [idConta] });
      await options.saveCampanha(repo, campanha);

      const found = await repo.findFirstByAdministrador(idConta);
      expect(found?.id).toBe(campanha.id);
      expect(found?.idsAdministradores).toContain(idConta);
    });

    it('findFirstByAdministrador returns the OLDEST matching campaign (aperture-p8i01)', async () => {
      const idConta = randomUUID();
      const idPlataforma = randomUUID();

      const older = makeCampanha({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-04-01T00:00:00.000Z'),
      });
      const newer = makeCampanha({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-05-01T00:00:00.000Z'),
      });

      // Save NEWER first to verify ordering is by criada_em ASC, not insertion order.
      await options.saveCampanha(repo, newer);
      await options.saveCampanha(repo, older);

      const found = await repo.findFirstByAdministrador(idConta);
      expect(found?.id).toBe(older.id);
    });

    it('delete removes the campaign + cascades to admins/opcoes (aperture-p8i01)', async () => {
      const campanha = makeCampanha({
        idsAdministradores: [randomUUID(), randomUUID()],
        opcoes: [
          { id: randomUUID(), tipo: 'presente' },
          { id: randomUUID(), tipo: 'rifa' },
        ],
      });
      await options.saveCampanha(repo, campanha);
      expect(await repo.findById(campanha.id)).toBeDefined();

      await repo.delete(campanha.id);

      expect(await repo.findById(campanha.id)).toBeUndefined();
      expect(await repo.findByPlataforma(campanha.idPlataforma)).toEqual([]);
    });

    it('delete is idempotent on unknown id (aperture-p8i01)', async () => {
      await expect(repo.delete(randomUUID())).resolves.not.toThrow();
    });

    it('delete emits db.arrecadacao_campanhas.delete span (aperture-p8i01)', async () => {
      await repo.delete(randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_campanhas.delete');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('DELETE');
    });

    // ───── findCampanhasByAdministrador (aperture-u2tko) ─────

    it('findCampanhasByAdministrador returns empty array when usuario administra nothing (aperture-u2tko)', async () => {
      const found = await repo.findCampanhasByAdministrador(randomUUID());
      expect(found).toEqual([]);
    });

    it('findCampanhasByAdministrador returns the matching campaign for 1 administered (aperture-u2tko)', async () => {
      const idConta = randomUUID();
      const campanha = makeCampanha({ idsAdministradores: [idConta] });
      await options.saveCampanha(repo, campanha);

      const found = await repo.findCampanhasByAdministrador(idConta);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(campanha.id);
      expect(found[0]?.idsAdministradores).toContain(idConta);
    });

    it('findCampanhasByAdministrador returns ALL matching campaigns for 2 administered, ordered criadaEm ASC (aperture-u2tko)', async () => {
      const idConta = randomUUID();
      const idPlataforma = randomUUID();

      const older = makeCampanha({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-04-01T00:00:00.000Z'),
      });
      const newer = makeCampanha({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-05-01T00:00:00.000Z'),
      });

      // Save NEWER first to verify ordering is by criada_em ASC, not insertion order.
      await options.saveCampanha(repo, newer);
      await options.saveCampanha(repo, older);

      const found = await repo.findCampanhasByAdministrador(idConta);
      expect(found).toHaveLength(2);
      expect(found.map((c) => c.id)).toEqual([older.id, newer.id]);
    });

    it('findCampanhasByAdministrador ignores campaigns where idConta is NOT an administrador (aperture-u2tko)', async () => {
      const idContaAlvo = randomUUID();
      const idContaOutro = randomUUID();

      const adminAlvo = makeCampanha({ idsAdministradores: [idContaAlvo] });
      const adminOutro = makeCampanha({ idsAdministradores: [idContaOutro] });
      const adminAmbos = makeCampanha({
        idsAdministradores: [idContaAlvo, idContaOutro],
      });

      await options.saveCampanha(repo, adminAlvo);
      await options.saveCampanha(repo, adminOutro);
      await options.saveCampanha(repo, adminAmbos);

      const found = await repo.findCampanhasByAdministrador(idContaAlvo);
      const ids = found.map((c) => c.id).sort();
      expect(ids).toEqual([adminAlvo.id, adminAmbos.id].sort());
      expect(ids).not.toContain(adminOutro.id);
    });

    it('findCampanhasByAdministrador includes campaigns WITHOUT recebedor (aperture-u2tko)', async () => {
      const idConta = randomUUID();
      const idPlataforma = randomUUID();

      const comRecebedor = makeCampanha({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-04-01T00:00:00.000Z'),
      });
      const semRecebedor = makeCampanhaSemRecebedor({
        idPlataforma,
        idsAdministradores: [idConta],
        criadaEm: new Date('2026-05-01T00:00:00.000Z'),
      });

      await options.saveCampanha(repo, comRecebedor);
      await options.saveCampanha(repo, semRecebedor);

      const found = await repo.findCampanhasByAdministrador(idConta);
      expect(found).toHaveLength(2);
      const sem = found.find((c) => c.id === semRecebedor.id);
      expect(sem).toBeDefined();
      expect(sem?.idRecebedor).toBeNull();
      expect(sem?.dadosRecebedor).toBeNull();
    });

    it('findCampanhasByAdministrador emits db.arrecadacao_campanhas.findCampanhasByAdministrador span (aperture-u2tko)', async () => {
      await repo.findCampanhasByAdministrador(randomUUID());
      const span = findSpan(
        options.getSpans(),
        'db.arrecadacao_campanhas.findCampanhasByAdministrador',
      );
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    // ───── findCampanhasByContribuinte (aperture-2ma52) ─────
    // Memory mode returns [] honestly (no contribuicoes data). Postgres
    // adapter is exercised in campanha-repository.postgres.test.ts with
    // real seeded contribuicoes rows.

    it('findCampanhasByContribuinte — empty email returns empty (aperture-2ma52)', async () => {
      const found = await repo.findCampanhasByContribuinte(randomUUID(), '');
      expect(found).toEqual([]);
    });

    it('findCampanhasByContribuinte — no contributions returns empty (aperture-2ma52)', async () => {
      const found = await repo.findCampanhasByContribuinte(randomUUID(), 'noone@example.com');
      expect(found).toEqual([]);
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
      metodo: 'pix',
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
