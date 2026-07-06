import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ListaDeConvidadosRepository } from '../../src/adapters/evento/lista-de-convidados-repository.js';
import type {
  Convidado,
  ListaDeConvidados,
} from '../../src/domain/evento/entities/lista-de-convidados.js';

interface ConformanceOptions {
  factory: () => ListaDeConvidadosRepository | Promise<ListaDeConvidadosRepository>;
  saveLista: (
    repo: ListaDeConvidadosRepository,
    listaDeConvidados: ListaDeConvidados,
  ) => Promise<void>;
  resetState?: () => Promise<void>;
  getSpans: () => ReadableSpan[];
  resetSpans: () => void;
  expectedDbSystem: string;
}

export function describeListaDeConvidadosRepositoryConformance(
  name: string,
  options: ConformanceOptions,
) {
  describe(`ListaDeConvidadosRepository conformance — ${name}`, () => {
    let repo: ListaDeConvidadosRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    it('saves and finds a guest list by ID', async () => {
      const lista = makeListaDeConvidados();
      await options.saveLista(repo, lista);

      const found = await repo.findById(lista.id);
      expect(found).toEqual(lista);
    });

    it('finds a guest list by event ID', async () => {
      const lista = makeListaDeConvidados();
      await options.saveLista(repo, lista);

      const found = await repo.findByIdEvento(lista.idEvento);
      expect(found).toEqual(lista);
    });

    it('returns undefined for unknown IDs', async () => {
      expect(await repo.findById(randomUUID())).toBeUndefined();
      expect(await repo.findByIdEvento(randomUUID())).toBeUndefined();
    });

    it('round-trips multiple guests', async () => {
      const lista = makeListaDeConvidados({
        convidados: [
          makeConvidado({ nome: 'Aline', presenca: 'sim' }),
          makeConvidado({ nome: 'Bruno', presenca: 'talvez' }),
          makeConvidado({ nome: 'Caio', presenca: 'nao' }),
        ],
      });
      await options.saveLista(repo, lista);

      const found = await repo.findById(lista.id);
      expect(found?.convidados.map((convidado) => convidado.nome)).toEqual([
        'Aline',
        'Bruno',
        'Caio',
      ]);
    });

    it('round-trips an empty guest list', async () => {
      const lista = makeListaDeConvidados({ convidados: [] });
      await options.saveLista(repo, lista);

      const found = await repo.findById(lista.id);
      expect(found).toEqual(lista);
    });

    it('alters only one guest RSVP and updates atualizadoEm', async () => {
      const convidadoA = makeConvidado({ nome: 'Aline', presenca: 'talvez' });
      const convidadoB = makeConvidado({ nome: 'Bruno', presenca: 'sim' });
      const lista = makeListaDeConvidados({
        convidados: [convidadoA, convidadoB],
      });
      await options.saveLista(repo, lista);

      const atualizadoEm = new Date('2026-06-20T12:00:00.000Z');
      const updated = await repo.alterarPresencaConvidado(
        lista.id,
        convidadoA.id,
        'nao',
        atualizadoEm,
      );

      expect(updated?.atualizadoEm).toEqual(atualizadoEm);
      expect(updated?.convidados).toEqual([{ ...convidadoA, presenca: 'nao' }, convidadoB]);
    });

    it('alterarPresencaConvidado returns undefined for missing list', async () => {
      const updated = await repo.alterarPresencaConvidado(
        randomUUID(),
        randomUUID(),
        'sim',
        new Date(),
      );
      expect(updated).toBeUndefined();
    });

    it('rejects saving a second list for the same event', async () => {
      const lista = makeListaDeConvidados();
      await options.saveLista(repo, lista);

      await expect(
        options.saveLista(
          repo,
          makeListaDeConvidados({
            idEvento: lista.idEvento,
          }),
        ),
      ).rejects.toThrow();
    });

    it('delete removes the guest list', async () => {
      const lista = makeListaDeConvidados();
      await options.saveLista(repo, lista);

      await repo.delete(lista.id);

      expect(await repo.findById(lista.id)).toBeUndefined();
      expect(await repo.findByIdEvento(lista.idEvento)).toBeUndefined();
    });

    it('delete is idempotent', async () => {
      await expect(repo.delete(randomUUID())).resolves.not.toThrow();
    });

    it('save emits db.listasDeConvidados.save span', async () => {
      await options.saveLista(repo, makeListaDeConvidados());
      const span = findSpan(options.getSpans(), 'db.listasDeConvidados.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('listas_de_convidados');
      expect(span?.attributes['db.operation.name']).toBe('UPSERT');
    });

    it('findById emits db.listasDeConvidados.findById span', async () => {
      await repo.findById(randomUUID());
      const span = findSpan(options.getSpans(), 'db.listasDeConvidados.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('listas_de_convidados');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('findByIdEvento emits db.listasDeConvidados.findByIdEvento span', async () => {
      await repo.findByIdEvento(randomUUID());
      const span = findSpan(options.getSpans(), 'db.listasDeConvidados.findByIdEvento');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('listas_de_convidados');
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
    });

    it('alterarPresencaConvidado emits db.listasDeConvidados.alterarPresencaConvidado span', async () => {
      await repo.alterarPresencaConvidado(randomUUID(), randomUUID(), 'sim', new Date());
      const span = findSpan(options.getSpans(), 'db.listasDeConvidados.alterarPresencaConvidado');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('listas_de_convidados');
      expect(span?.attributes['db.operation.name']).toBe('UPDATE');
    });

    it('delete emits db.listasDeConvidados.delete span', async () => {
      await repo.delete(randomUUID());
      const span = findSpan(options.getSpans(), 'db.listasDeConvidados.delete');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.collection.name']).toBe('listas_de_convidados');
      expect(span?.attributes['db.operation.name']).toBe('DELETE');
    });
  });
}

export function makeListaDeConvidados(
  overrides: Partial<ListaDeConvidados> = {},
): ListaDeConvidados {
  return {
    id: randomUUID(),
    idEvento: randomUUID(),
    formatoMensagemConvite: 'texto',
    convidados: [makeConvidado()],
    criadoEm: new Date('2026-06-10T10:00:00.000Z'),
    atualizadoEm: new Date('2026-06-10T10:00:00.000Z'),
    ...overrides,
  };
}

export function makeConvidado(overrides: Partial<Convidado> = {}): Convidado {
  return {
    id: randomUUID(),
    nome: 'Mariana',
    numeroCelular: '+55 11 99999-9999',
    presenca: 'talvez',
    ...overrides,
  };
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((span) => span.name === name);
}
