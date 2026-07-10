import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EventoRepository } from '../../src/adapters/evento/evento-repository.js';
import type { Evento } from '../../src/domain/evento/entities/evento.js';

interface ConformanceOptions {
  factory: () => EventoRepository | Promise<EventoRepository>;
  saveEvento: (repo: EventoRepository, evento: Evento) => Promise<void>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeEventoRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`EventoRepository conformance — ${name}`, () => {
    let repo: EventoRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    it('saves and finds an event by ID', async () => {
      const evento = makeEvento();
      await options.saveEvento(repo, evento);

      const found = await repo.findById(evento.id);
      expect(found).toEqual(evento);
    });

    it('finds an event by campanha ID', async () => {
      const evento = makeEvento();
      await options.saveEvento(repo, evento);

      const found = await repo.findByIdCampanha(evento.idCampanha);
      expect(found).toEqual(evento);
    });

    it('round-trips an event without endereco', async () => {
      const evento = makeEvento({ endereco: null, modalidade: 'online' });
      await options.saveEvento(repo, evento);

      const found = await repo.findById(evento.id);
      expect(found).toEqual(evento);
    });

    it('round-trips an event without dataHora (date/time undecided)', async () => {
      const evento = makeEvento({ dataHora: null });
      await options.saveEvento(repo, evento);

      const found = await repo.findById(evento.id);
      expect(found).toEqual(evento);
    });

    it('round-trips a PARTIAL wizard-seeded row (modalidade + dataHora null) — aperture-mu1v9', async () => {
      const evento = makeEvento({ modalidade: null, dataHora: null, endereco: null });
      await options.saveEvento(repo, evento);

      const found = await repo.findById(evento.id);
      expect(found).toEqual(evento);
    });

    it('round-trips a date-only partial row (tipoEvento null) — aperture-mu1v9', async () => {
      const evento = makeEvento({ tipoEvento: null, modalidade: null, endereco: null });
      await options.saveEvento(repo, evento);

      const found = await repo.findByIdCampanha(evento.idCampanha);
      expect(found).toEqual(evento);
    });

    it('returns undefined for unknown IDs', async () => {
      expect(await repo.findById(randomUUID())).toBeUndefined();
      expect(await repo.findByIdCampanha(randomUUID())).toBeUndefined();
    });

    it('rejects saving a second event for the same campanha', async () => {
      const evento = makeEvento();
      await options.saveEvento(repo, evento);

      await expect(
        options.saveEvento(
          repo,
          makeEvento({
            idCampanha: evento.idCampanha,
          }),
        ),
      ).rejects.toThrow();
    });

    it('delete removes the event', async () => {
      const evento = makeEvento();
      await options.saveEvento(repo, evento);

      await repo.delete(evento.id);

      expect(await repo.findById(evento.id)).toBeUndefined();
      expect(await repo.findByIdCampanha(evento.idCampanha)).toBeUndefined();
    });

    it('delete is idempotent', async () => {
      await expect(repo.delete(randomUUID())).resolves.not.toThrow();
    });

    it('save emits db.eventos.save span', async () => {
      await options.saveEvento(repo, makeEvento());
      const span = findSpan(options.getSpans(), 'db.eventos.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('eventos');
      expect(span?.attributes['db.operation.name']).toBe('UPSERT');
    });

    it('findById emits db.eventos.findById span', async () => {
      await repo.findById(randomUUID());
      const span = findSpan(options.getSpans(), 'db.eventos.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('eventos');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('findByIdCampanha emits db.eventos.findByIdCampanha span', async () => {
      await repo.findByIdCampanha(randomUUID());
      const span = findSpan(options.getSpans(), 'db.eventos.findByIdCampanha');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('eventos');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('delete emits db.eventos.delete span', async () => {
      await repo.delete(randomUUID());
      const span = findSpan(options.getSpans(), 'db.eventos.delete');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('eventos');
      expect(span?.attributes['db.operation.name']).toBe('DELETE');
    });
  });
}

export function makeEvento(overrides: Partial<Evento> = {}): Evento {
  return {
    id: randomUUID(),
    idCampanha: randomUUID(),
    tipoEvento: 'cha-bebe',
    modalidade: 'presencial',
    dataHora: new Date('2026-06-15T18:00:00.000Z'),
    endereco: 'Salao principal',
    criadoEm: new Date('2026-06-10T10:00:00.000Z'),
    atualizadoEm: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((span) => span.name === name);
}
