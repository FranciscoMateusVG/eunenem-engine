import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../../src/domain/arrecadacao/entities/campanha.js';
import { EventoCampanhaJaTemEventoError } from '../../../src/errors/evento/campanha-ja-tem-evento.error.js';
import { EventoCampanhaNaoEncontradaError } from '../../../src/errors/evento/campanha-nao-encontrada.error.js';
import { EventoInputInvalidoError } from '../../../src/errors/evento/input-invalido.error.js';
import { EventoNaoEncontradoError } from '../../../src/errors/evento/nao-encontrado.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { atualizarEvento } from '../../../src/use-cases/evento/atualizar-evento.js';
import { criarEvento } from '../../../src/use-cases/evento/criar-evento.js';
import { obterEventoPorId } from '../../../src/use-cases/evento/obter-evento-por-id.js';
import { obterEventoPorIdCampanha } from '../../../src/use-cases/evento/obter-evento-por-id-campanha.js';
import { createEventoMemoryRepos } from '../../helpers/evento-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-06-15T18:00:00.000Z');
const clock = () => fixedDate;

async function seedCampanha(repos: ReturnType<typeof createEventoMemoryRepos>) {
  const idCampanha = randomUUID();
  const campanha = criarCampanhaSemRecebedor({
    id: idCampanha,
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idsAdministradores: [randomUUID()],
    titulo: 'Lista teste',
    opcoes: [],
    criadaEm: fixedDate,
  });
  await repos.campanhaRepository.save(campanha);
  return idCampanha;
}

describe('criarEvento', () => {
  it('creates event when campanha exists', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    const idEvento = randomUUID();

    const evento = await criarEvento(
      {
        eventoRepository: repos.eventoRepository,
        campanhaRepository: repos.campanhaRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idEvento,
        idCampanha,
        tipoEvento: 'cha-fraldas',
        modalidade: 'presencial',
        dataHora: fixedDate,
        endereco: 'Salão A',
      },
    );

    expect(evento.id).toBe(idEvento);
    expect(evento.idCampanha).toBe(idCampanha);
    expect(evento.tipoEvento).toBe('cha-fraldas');

    const loaded = await repos.eventoRepository.findByIdCampanha(idCampanha);
    expect(loaded?.id).toBe(idEvento);
  });

  it('throws EventoCampanhaNaoEncontradaError when campanha missing', async () => {
    const repos = createEventoMemoryRepos();
    await expect(
      criarEvento(
        {
          eventoRepository: repos.eventoRepository,
          campanhaRepository: repos.campanhaRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idCampanha: randomUUID(),
          tipoEvento: 'aniversario',
          modalidade: 'online',
          dataHora: fixedDate,
          endereco: null,
        },
      ),
    ).rejects.toBeInstanceOf(EventoCampanhaNaoEncontradaError);
  });

  it('throws EventoCampanhaJaTemEventoError on second create for same campanha', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    const deps = {
      eventoRepository: repos.eventoRepository,
      campanhaRepository: repos.campanhaRepository,
      clock,
      observability: silentObservability,
    };
    const base = {
      idCampanha,
      tipoEvento: 'cha-bebe' as const,
      modalidade: 'online' as const,
      dataHora: fixedDate,
      endereco: null,
    };

    await criarEvento(deps, { ...base, id: randomUUID() });

    await expect(criarEvento(deps, { ...base, id: randomUUID() })).rejects.toBeInstanceOf(
      EventoCampanhaJaTemEventoError,
    );
  });

  it('throws EventoInputInvalidoError for invalid tipo', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    await expect(
      criarEvento(
        {
          eventoRepository: repos.eventoRepository,
          campanhaRepository: repos.campanhaRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idCampanha,
          tipoEvento: 'festa' as 'cha-bebe',
          modalidade: 'presencial',
          dataHora: fixedDate,
          endereco: null,
        },
      ),
    ).rejects.toBeInstanceOf(EventoInputInvalidoError);
  });
});

describe('atualizarEvento', () => {
  it('updates fields and bumps atualizadoEm', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    const idEvento = randomUUID();
    const updateClock = () => new Date('2026-06-20T12:00:00.000Z');

    await criarEvento(
      {
        eventoRepository: repos.eventoRepository,
        campanhaRepository: repos.campanhaRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idEvento,
        idCampanha,
        tipoEvento: 'batizado',
        modalidade: 'presencial',
        dataHora: fixedDate,
        endereco: null,
      },
    );

    const newDataHora = new Date('2026-07-01T15:00:00.000Z');
    const updated = await atualizarEvento(
      {
        eventoRepository: repos.eventoRepository,
        clock: updateClock,
        observability: silentObservability,
      },
      {
        id: idEvento,
        tipoEvento: 'cha-revelacao',
        modalidade: 'online',
        dataHora: newDataHora,
        endereco: 'Link Zoom',
      },
    );

    expect(updated.tipoEvento).toBe('cha-revelacao');
    expect(updated.modalidade).toBe('online');
    expect(updated.endereco).toBe('Link Zoom');
    expect(updated.atualizadoEm).toEqual(updateClock());
  });
});

describe('obterEvento', () => {
  it('obterEventoPorId returns evento', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    const idEvento = randomUUID();

    await criarEvento(
      {
        eventoRepository: repos.eventoRepository,
        campanhaRepository: repos.campanhaRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idEvento,
        idCampanha,
        tipoEvento: 'cha-surpresa',
        modalidade: 'presencial',
        dataHora: fixedDate,
        endereco: null,
      },
    );

    const loaded = await obterEventoPorId(
      { eventoRepository: repos.eventoRepository, observability: silentObservability },
      { id: idEvento },
    );
    expect(loaded.id).toBe(idEvento);
  });

  it('obterEventoPorId throws EventoNaoEncontradoError when missing', async () => {
    const repos = createEventoMemoryRepos();
    await expect(
      obterEventoPorId(
        { eventoRepository: repos.eventoRepository, observability: silentObservability },
        { id: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(EventoNaoEncontradoError);
  });

  it('obterEventoPorIdCampanha returns evento by campanha', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    const idEvento = randomUUID();

    await criarEvento(
      {
        eventoRepository: repos.eventoRepository,
        campanhaRepository: repos.campanhaRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idEvento,
        idCampanha,
        tipoEvento: 'aniversario',
        modalidade: 'online',
        dataHora: fixedDate,
        endereco: null,
      },
    );

    const loaded = await obterEventoPorIdCampanha(
      { eventoRepository: repos.eventoRepository, observability: silentObservability },
      { idCampanha },
    );
    expect(loaded.id).toBe(idEvento);
  });

  it('obterEventoPorIdCampanha throws when no event for campanha', async () => {
    const repos = createEventoMemoryRepos();
    const idCampanha = await seedCampanha(repos);
    await expect(
      obterEventoPorIdCampanha(
        { eventoRepository: repos.eventoRepository, observability: silentObservability },
        { idCampanha },
      ),
    ).rejects.toBeInstanceOf(EventoNaoEncontradoError);
  });
});
