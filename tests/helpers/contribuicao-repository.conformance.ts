import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContribuicaoRepository } from '../../src/adapters/arrecadacao/contribuicao-repository.js';
import type { Contribuicao } from '../../src/domain/arrecadacao/entities/contribuicao.js';

interface ConformanceOptions {
  factory: () => ContribuicaoRepository | Promise<ContribuicaoRepository>;
  resetState?: () => Promise<void>;
  /** Garante pré-requisitos (ex.: campanha e opção no Postgres por FK). */
  seedForContribuicao?: (contribuicao: Contribuicao) => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeContribuicaoRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`ContribuicaoRepository conformance — ${name}`, () => {
    let repo: ContribuicaoRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    it('saves and finds a contribution by ID', async () => {
      const contribuicao = makeContribuicao();
      await options.seedForContribuicao?.(contribuicao);
      await repo.save(contribuicao);

      const found = await repo.findById(contribuicao.id);
      expect(found).toEqual(contribuicao);
    });

    it('returns undefined for non-existent ID', async () => {
      const found = await repo.findById(randomUUID());
      expect(found).toBeUndefined();
    });

    it('upserts contribution on second save with same id', async () => {
      const contribuicao = makeContribuicao();
      await options.seedForContribuicao?.(contribuicao);
      await repo.save(contribuicao);

      const updated: Contribuicao = {
        ...contribuicao,
        status: 'indisponivel',
        contribuinte: { nome: 'Visitante', email: 'v@exemplo.com' },
      };
      await repo.save(updated);

      const found = await repo.findById(contribuicao.id);
      expect(found).toEqual(updated);
    });

    it('save emits db.arrecadacao_contribuicoes.save span', async () => {
      const contribuicao = makeContribuicao();
      await options.seedForContribuicao?.(contribuicao);
      await repo.save(contribuicao);
      const span = findSpan(options.getSpans(), 'db.arrecadacao_contribuicoes.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('UPSERT');
    });

    it('findById emits db.arrecadacao_contribuicoes.findById span', async () => {
      await repo.findById(randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_contribuicoes.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('findByCampanhaId returns only contributions belonging to that campaign', async () => {
      const idCampanhaA = randomUUID();
      const idOpcaoA = randomUUID();
      const idCampanhaB = randomUUID();
      const idOpcaoB = randomUUID();

      // Two contribuições share campanha A (and its single opção) so the
      // Postgres seed (which inserts one active recebedor per campanha) is
      // only invoked once per campanha.
      const cA1 = makeContribuicao({ idCampanha: idCampanhaA, idOpcaoContribuicao: idOpcaoA });
      const cA2 = makeContribuicao({ idCampanha: idCampanhaA, idOpcaoContribuicao: idOpcaoA });
      const cB1 = makeContribuicao({ idCampanha: idCampanhaB, idOpcaoContribuicao: idOpcaoB });

      await options.seedForContribuicao?.(cA1);
      await options.seedForContribuicao?.(cB1);
      await repo.save(cA1);
      await repo.save(cA2);
      await repo.save(cB1);

      const foundForA = await repo.findByCampanhaId(idCampanhaA);
      const idsForA = foundForA.map((c) => c.id).sort();
      expect(idsForA).toEqual([cA1.id, cA2.id].sort());

      const foundForB = await repo.findByCampanhaId(idCampanhaB);
      expect(foundForB.map((c) => c.id)).toEqual([cB1.id]);
    });

    it('findByCampanhaId returns empty array when no contributions match', async () => {
      const found = await repo.findByCampanhaId(randomUUID());
      expect(found).toEqual([]);
    });

    it('findByCampanhaId emits db.arrecadacao_contribuicoes.findByCampanhaId span', async () => {
      await repo.findByCampanhaId(randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_contribuicoes.findByCampanhaId');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('countByOpcao returns the number of contributions for a (campanha, opção) pair', async () => {
      // Use two campanhas so the Postgres seed (which creates one active
      // recebedor per campanha) is invoked once per campanha — avoids
      // unique-index collision on recebedores_campanha_ativo_unique.
      const idCampanhaA = randomUUID();
      const idOpcaoA = randomUUID();
      const idCampanhaB = randomUUID();
      const idOpcaoB = randomUUID();

      const cA1 = makeContribuicao({ idCampanha: idCampanhaA, idOpcaoContribuicao: idOpcaoA });
      const cA2 = makeContribuicao({ idCampanha: idCampanhaA, idOpcaoContribuicao: idOpcaoA });
      const cB1 = makeContribuicao({ idCampanha: idCampanhaB, idOpcaoContribuicao: idOpcaoB });

      await options.seedForContribuicao?.(cA1);
      await options.seedForContribuicao?.(cB1);
      await repo.save(cA1);
      await repo.save(cA2);
      await repo.save(cB1);

      expect(await repo.countByOpcao(idCampanhaA, idOpcaoA)).toBe(2);
      expect(await repo.countByOpcao(idCampanhaB, idOpcaoB)).toBe(1);
      expect(await repo.countByOpcao(idCampanhaA, randomUUID())).toBe(0);
    });

    it('countByOpcao emits db.arrecadacao_contribuicoes.countByOpcao span', async () => {
      await repo.countByOpcao(randomUUID(), randomUUID());
      const span = findSpan(options.getSpans(), 'db.arrecadacao_contribuicoes.countByOpcao');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });
  });
}

function makeContribuicao(overrides: Partial<Contribuicao> = {}): Contribuicao {
  return {
    id: randomUUID(),
    idCampanha: randomUUID(),
    idOpcaoContribuicao: randomUUID(),
    nome: 'Fralda',
    valor: 8000,
    imagemUrl: null,
    grupo: null,
    contribuinte: null,
    status: 'disponivel',
    criadaEm: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
