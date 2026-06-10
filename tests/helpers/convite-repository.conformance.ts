import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConviteRepository } from '../../src/adapters/evento/convite-repository.js';
import type { Convite } from '../../src/domain/evento/entities/convite.js';

interface ConformanceOptions {
  factory: () => ConviteRepository | Promise<ConviteRepository>;
  saveConvite: (repo: ConviteRepository, convite: Convite) => Promise<void>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeConviteRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`ConviteRepository conformance — ${name}`, () => {
    let repo: ConviteRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    it('saves and finds an invite by ID', async () => {
      const convite = makeConvite();
      await options.saveConvite(repo, convite);

      const found = await repo.findById(convite.id);
      expect(found).toEqual(convite);
    });

    it('finds an invite by evento ID', async () => {
      const convite = makeConvite();
      await options.saveConvite(repo, convite);

      const found = await repo.findByIdEvento(convite.idEvento);
      expect(found).toEqual(convite);
    });

    it('round-trips an invite without image url', async () => {
      const convite = makeConvite({ imagemUrl: undefined });
      await options.saveConvite(repo, convite);

      const found = await repo.findById(convite.id);
      expect(found).toEqual(convite);
    });

    it('returns undefined for unknown IDs', async () => {
      expect(await repo.findById(randomUUID())).toBeUndefined();
      expect(await repo.findByIdEvento(randomUUID())).toBeUndefined();
    });

    it('rejects saving a second invite for the same event', async () => {
      const convite = makeConvite();
      await options.saveConvite(repo, convite);

      await expect(
        options.saveConvite(
          repo,
          makeConvite({
            idEvento: convite.idEvento,
          }),
        ),
      ).rejects.toThrow();
    });

    it('delete removes the invite', async () => {
      const convite = makeConvite();
      await options.saveConvite(repo, convite);

      await repo.delete(convite.id);

      expect(await repo.findById(convite.id)).toBeUndefined();
      expect(await repo.findByIdEvento(convite.idEvento)).toBeUndefined();
    });

    it('delete is idempotent', async () => {
      await expect(repo.delete(randomUUID())).resolves.not.toThrow();
    });

    it('save emits db.convites.save span', async () => {
      await options.saveConvite(repo, makeConvite());
      const span = findSpan(options.getSpans(), 'db.convites.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('convites');
      expect(span?.attributes['db.operation.name']).toBe('UPSERT');
    });

    it('findById emits db.convites.findById span', async () => {
      await repo.findById(randomUUID());
      const span = findSpan(options.getSpans(), 'db.convites.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('convites');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('findByIdEvento emits db.convites.findByIdEvento span', async () => {
      await repo.findByIdEvento(randomUUID());
      const span = findSpan(options.getSpans(), 'db.convites.findByIdEvento');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('convites');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('delete emits db.convites.delete span', async () => {
      await repo.delete(randomUUID());
      const span = findSpan(options.getSpans(), 'db.convites.delete');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('convites');
      expect(span?.attributes['db.operation.name']).toBe('DELETE');
    });
  });
}

export function makeConvite(overrides: Partial<Convite> = {}): Convite {
  return {
    id: randomUUID(),
    idEvento: randomUUID(),
    remetente: 'Os pais',
    nomeExibido: 'Cha da Maria',
    mensagem: 'Esperamos voce para celebrar esse momento especial.',
    paleta: 'lilas',
    fonte: 'patrick',
    modelo: 'scrapbook',
    imagemUrl: 'https://cdn.example.com/convite.png',
    criadoEm: new Date('2026-06-10T10:00:00.000Z'),
    atualizadoEm: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((span) => span.name === name);
}
