import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CampanhaRepository } from '../../src/adapters/arrecadacao/campanha-repository.js';
import type { Campanha } from '../../src/domain/arrecadacao/campanha.js';

interface ConformanceOptions {
  factory: () => CampanhaRepository | Promise<CampanhaRepository>;
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
      await repo.save(campanha);

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
      await repo.save(campanha);
      const found = await repo.findById(campanha.id);
      expect(found).toEqual(campanha);
    });

    it('save emits db.arrecadacao_campanhas.save span', async () => {
      await repo.save(makeCampanha());
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
  });
}

function makeCampanha(overrides: Partial<Campanha> = {}): Campanha {
  return {
    id: randomUUID(),
    idsAdministradores: [randomUUID()],
    idRecebedor: randomUUID(),
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

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
