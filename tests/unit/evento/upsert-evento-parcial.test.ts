/**
 * aperture-mu1v9 (fblrt W3-c) — upsertEventoParcial unit tests.
 *
 * The wizard/perfil write path into the `eventos` single source: writes ONLY
 * the (tipoEvento, dataHora) pair — creates a PARTIAL row when absent,
 * PRESERVES modalidade/endereco when a convite-saved row already exists.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventoRepositoryMemory } from '../../../src/adapters/evento/evento-repository.memory.js';
import { criarEvento as criarEventoDominio } from '../../../src/domain/evento/entities/evento.js';
import { EventoInputInvalidoError } from '../../../src/errors/evento/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { upsertEventoParcial } from '../../../src/use-cases/evento/upsert-evento-parcial.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-06-15T18:00:00.000Z');
const laterDate = new Date('2026-06-20T10:00:00.000Z');

function makeDeps(clockDate: Date = fixedDate) {
  const eventoRepository = new EventoRepositoryMemory();
  return {
    eventoRepository,
    deps: {
      eventoRepository,
      clock: () => clockDate,
      observability: silentObservability,
    },
  };
}

describe('upsertEventoParcial', () => {
  it('creates a PARTIAL row when the campanha has no evento (modalidade/endereco null)', async () => {
    const { deps, eventoRepository } = makeDeps();
    const idCampanha = randomUUID();
    const id = randomUUID();

    const evento = await upsertEventoParcial(deps, {
      id,
      idCampanha,
      tipoEvento: 'cha-bebe',
      dataHora: laterDate,
    });

    expect(evento).not.toBeNull();
    expect(evento?.id).toBe(id);
    expect(evento?.tipoEvento).toBe('cha-bebe');
    expect(evento?.dataHora).toEqual(laterDate);
    expect(evento?.modalidade).toBeNull();
    expect(evento?.endereco).toBeNull();

    const persisted = await eventoRepository.findByIdCampanha(idCampanha);
    expect(persisted).toEqual(evento);
  });

  it('updates ONLY the pair on an existing row — modalidade/endereco PRESERVED', async () => {
    const { deps, eventoRepository } = makeDeps();
    const idCampanha = randomUUID();
    const existing = criarEventoDominio({
      id: randomUUID(),
      idCampanha,
      tipoEvento: 'batizado',
      modalidade: 'presencial',
      dataHora: fixedDate,
      endereco: 'Salão principal',
      criadoEm: fixedDate,
      atualizadoEm: fixedDate,
    });
    await eventoRepository.save(existing);

    const evento = await upsertEventoParcial(
      { ...deps, clock: () => laterDate },
      {
        id: randomUUID(), // ignored — existing row wins
        idCampanha,
        tipoEvento: 'aniversario',
        dataHora: laterDate,
      },
    );

    expect(evento?.id).toBe(existing.id);
    expect(evento?.tipoEvento).toBe('aniversario');
    expect(evento?.dataHora).toEqual(laterDate);
    // The convite-saved where/how survives the wizard re-run.
    expect(evento?.modalidade).toBe('presencial');
    expect(evento?.endereco).toBe('Salão principal');
    expect(evento?.criadoEm).toEqual(fixedDate);
    expect(evento?.atualizadoEm).toEqual(laterDate);
  });

  it('allows a null dataHora (date undecided) on create and on update', async () => {
    const { deps, eventoRepository } = makeDeps();
    const idCampanha = randomUUID();

    const created = await upsertEventoParcial(deps, {
      id: randomUUID(),
      idCampanha,
      tipoEvento: 'cha-fraldas',
      dataHora: null,
    });
    expect(created?.dataHora).toBeNull();
    expect(created?.tipoEvento).toBe('cha-fraldas');

    // Clearing the date on the existing row is a legitimate wizard write.
    const cleared = await upsertEventoParcial(deps, {
      id: randomUUID(),
      idCampanha,
      tipoEvento: 'cha-fraldas',
      dataHora: null,
    });
    expect(cleared?.id).toBe(created?.id);
    expect(cleared?.dataHora).toBeNull();
    expect(await eventoRepository.findByIdCampanha(idCampanha)).toEqual(cleared);
  });

  it('creates a date-only partial row (tipoEvento null, dataHora set)', async () => {
    const { deps } = makeDeps();
    const evento = await upsertEventoParcial(deps, {
      id: randomUUID(),
      idCampanha: randomUUID(),
      tipoEvento: null,
      dataHora: laterDate,
    });
    expect(evento?.tipoEvento).toBeNull();
    expect(evento?.dataHora).toEqual(laterDate);
  });

  it('skips creation when both values are null and no row exists (returns null)', async () => {
    const { deps, eventoRepository } = makeDeps();
    const idCampanha = randomUUID();

    const result = await upsertEventoParcial(deps, {
      id: randomUUID(),
      idCampanha,
      tipoEvento: null,
      dataHora: null,
    });

    expect(result).toBeNull();
    expect(await eventoRepository.findByIdCampanha(idCampanha)).toBeUndefined();
  });

  it('rejects an invalid tipoEvento at the boundary', async () => {
    const { deps } = makeDeps();
    await expect(
      upsertEventoParcial(deps, {
        id: randomUUID(),
        idCampanha: randomUUID(),
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        tipoEvento: 'festa-surpresa' as any,
        dataHora: null,
      }),
    ).rejects.toBeInstanceOf(EventoInputInvalidoError);
  });
});
