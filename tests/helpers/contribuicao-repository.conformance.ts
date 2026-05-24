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
  });
}

function makeContribuicao(overrides: Partial<Contribuicao> = {}): Contribuicao {
  return {
    id: randomUUID(),
    idCampanha: randomUUID(),
    idOpcaoContribuicao: randomUUID(),
    nome: 'Fralda',
    valor: 8000,
    contribuinte: null,
    status: 'disponivel',
    criadaEm: new Date('2026-05-01T12:00:00.000Z'),
    ...overrides,
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
