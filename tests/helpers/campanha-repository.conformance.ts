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

    // ─── aperture-u38rz — findByAdministrador DETERMINISM GUARD ────────────
    //
    // Once campanhas.criar (aperture-x0unf) lets a conta own MULTIPLE
    // campanhas, every single-resolve site (/pagina, painel, contribuicao,
    // evento routers) must keep resolving the SAME campanha it always did:
    // the OLDEST (criada_em ASC, id ASC tiebreak). A LIMIT 1 with no ORDER BY
    // is Postgres roulette — an existing user's LIVE gift page must never
    // nondeterministically swap to a freshly-created empty list.
    //
    // Fixtures deliberately save the NEWER campanha FIRST so an
    // insertion-order-accidental implementation fails loudly here.
    describe('findByAdministrador — deterministic oldest-first (aperture-u38rz)', () => {
      const REPEATS = 5;

      it('returns undefined when the conta administers no campanha', async () => {
        expect(await repo.findByAdministrador(randomUUID() as never)).toBeUndefined();
      });

      it('two campanhas, different criada_em → ALWAYS the oldest, across repeated calls', async () => {
        const idConta = randomUUID();
        const nova = makeCampanha({
          idsAdministradores: [idConta],
          titulo: 'Lista nova (vazia)',
          criadaEm: new Date('2026-07-01T12:00:00.000Z'),
        });
        const antiga = makeCampanha({
          idsAdministradores: [idConta],
          titulo: 'Lista antiga (a página viva)',
          criadaEm: new Date('2026-05-01T12:00:00.000Z'),
        });
        // NEWER saved FIRST — insertion order must not matter.
        await options.saveCampanha(repo, nova);
        await options.saveCampanha(repo, antiga);

        for (let i = 0; i < REPEATS; i++) {
          const found = await repo.findByAdministrador(idConta as never);
          expect(found?.id, `call ${i + 1}/${REPEATS} must resolve the OLDEST campanha`).toBe(
            antiga.id,
          );
        }
      });

      it('same criada_em → lowest id wins, stable across repeated calls', async () => {
        const idConta = randomUUID();
        const criadaEm = new Date('2026-06-15T09:30:00.000Z');
        // Fixed ids make the tiebreak deterministic and readable: 0… < f….
        const idBaixo = '00000000-0000-4000-8000-000000000001';
        const idAlto = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
        const alta = makeCampanha({
          id: idAlto as never,
          idsAdministradores: [idConta],
          titulo: 'Empate — id alto',
          criadaEm,
        });
        const baixa = makeCampanha({
          id: idBaixo as never,
          idsAdministradores: [idConta],
          titulo: 'Empate — id baixo',
          criadaEm,
        });
        // Higher id saved FIRST — the tiebreak must come from ORDER BY, not
        // from insertion order.
        await options.saveCampanha(repo, alta);
        await options.saveCampanha(repo, baixa);

        for (let i = 0; i < REPEATS; i++) {
          const found = await repo.findByAdministrador(idConta as never);
          expect(found?.id, `call ${i + 1}/${REPEATS}: lowest id must win the tie`).toBe(idBaixo);
        }
      });

      it('resolves a campanha SEM RECEBEDOR — pre-bank-info is a legit lifecycle state (parity ruling, aperture-x0unf)', async () => {
        // Ruled by Rex 2026-07-08 (folded into #332): postgres was already
        // returning the campanha for a recebedor-less resolve; memory used to
        // return undefined (stale pre-66klh guard) — a tests-lie-about-prod
        // divergence surfaced by the u38rz compensation test. This case PINS
        // parity: both adapters resolve the campanha, recebedor-less. Matters
        // because campanhas.criar mints exactly this state ({titulo} only).
        const idConta = randomUUID();
        const semRecebedor = makeCampanhaSemRecebedor({
          idsAdministradores: [idConta],
          criadaEm: new Date('2026-06-01T00:00:00.000Z'),
        });
        await options.saveCampanha(repo, semRecebedor);

        const found = await repo.findByAdministrador(idConta as never);
        expect(found?.id, 'a pre-bank-info campanha must still resolve').toBe(semRecebedor.id);
        expect(found?.idRecebedor, 'and stay recebedor-less in the result').toBeNull();
      });

      it('an unrelated conta creating campanhas never changes MY resolution', async () => {
        const minhaConta = randomUUID();
        const outraConta = randomUUID();
        const minha = makeCampanha({
          idsAdministradores: [minhaConta],
          criadaEm: new Date('2026-04-01T00:00:00.000Z'),
        });
        await options.saveCampanha(repo, minha);
        // Noise: another conta's newer campanhas must be invisible to mine.
        for (let i = 0; i < 3; i++) {
          await options.saveCampanha(
            repo,
            makeCampanha({
              idsAdministradores: [outraConta],
              criadaEm: new Date(`2026-07-0${i + 1}T00:00:00.000Z`),
            }),
          );
        }
        expect((await repo.findByAdministrador(minhaConta as never))?.id).toBe(minha.id);
      });
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

    // ───── slug + updateSlug (aperture-aphk8) ─────

    it('save round-trips a campanha slug (aperture-aphk8)', async () => {
      const campanha = makeCampanha({ slug: 'minha-lista' });
      await options.saveCampanha(repo, campanha);
      expect((await repo.findById(campanha.id))?.slug).toBe('minha-lista');
    });

    it('slug defaults to null and round-trips as null (aperture-aphk8)', async () => {
      const campanha = makeCampanha();
      await options.saveCampanha(repo, campanha);
      expect((await repo.findById(campanha.id))?.slug).toBeNull();
    });

    it('updateSlug persists the slug without touching the rest of the aggregate (aperture-aphk8)', async () => {
      const campanha = makeCampanha({
        idsAdministradores: [randomUUID()],
        opcoes: [{ id: randomUUID(), tipo: 'presente' }],
      });
      await options.saveCampanha(repo, campanha);

      await repo.updateSlug(campanha.id, 'lista-da-helena');

      const found = await repo.findById(campanha.id);
      expect(found?.slug).toBe('lista-da-helena');
      expect(found?.titulo).toBe(campanha.titulo);
      expect(found?.idsAdministradores).toEqual(campanha.idsAdministradores);
      expect(found?.opcoes).toEqual(campanha.opcoes);
    });

    it('updateSlug(null) clears a previously-set slug (aperture-aphk8)', async () => {
      const campanha = makeCampanha({ slug: 'antigo' });
      await options.saveCampanha(repo, campanha);

      await repo.updateSlug(campanha.id, null);

      expect((await repo.findById(campanha.id))?.slug).toBeNull();
    });

    it('updateSlug is a no-op for an unknown id (aperture-aphk8)', async () => {
      await expect(repo.updateSlug(randomUUID(), 'qualquer')).resolves.not.toThrow();
    });

    // aperture-y8e9w: validarSlug's em_uso check reads slugs THROUGH
    // findCampanhasByAdministrador (checkCampanhaSlug iterates its result).
    // The postgres impl currently hydrates via findById, so slug comes along
    // transitively — but that delegation is an implementation detail. If a
    // future optimization flattens the N+1 into a hand-rolled row mapping
    // and forgets slug, validarSlug silently reports every taken slug as
    // available (the exact operator-reported symptom). This pins the port
    // promise explicitly at the read path validarSlug actually uses.
    it('findCampanhasByAdministrador hydrates slug set via updateSlug (aperture-y8e9w)', async () => {
      const idConta = randomUUID();
      const campanhaA = makeCampanha({ idsAdministradores: [idConta] });
      const campanhaB = makeCampanha({ idsAdministradores: [idConta] });
      await options.saveCampanha(repo, campanhaA);
      await options.saveCampanha(repo, campanhaB);

      await repo.updateSlug(campanhaA.id, 'francisco');

      const campanhas = await repo.findCampanhasByAdministrador(idConta);
      const porId = new Map(campanhas.map((c) => [c.id, c.slug]));
      expect(porId.get(campanhaA.id)).toBe('francisco');
      expect(porId.get(campanhaB.id)).toBeNull();
    });

    it('updateSlug emits db.arrecadacao_campanhas.updateSlug span (aperture-aphk8)', async () => {
      await repo.updateSlug(randomUUID(), 'qualquer');
      const span = findSpan(options.getSpans(), 'db.arrecadacao_campanhas.updateSlug');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('UPDATE');
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
      cpfTitular: '52998224725',
      tipoChavePix: 'email',
      chavePix: 'maria@exemplo.com',
    },
    titulo: 'Campanha teste',
    slug: null,
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
    slug: null,
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
