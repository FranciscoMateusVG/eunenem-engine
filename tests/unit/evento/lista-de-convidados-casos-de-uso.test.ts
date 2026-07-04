import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../../src/domain/arrecadacao/entities/campanha.js';
import { ConvidadoNaoEncontradoError } from '../../../src/errors/evento/convidado-nao-encontrado.error.js';
import { ListaDeConvidadosInputInvalidoError } from '../../../src/errors/evento/lista-de-convidados-input-invalido.error.js';
import { ListaDeConvidadosJaExisteError } from '../../../src/errors/evento/lista-de-convidados-ja-existe.error.js';
import { ListaDeConvidadosNaoEncontradaError } from '../../../src/errors/evento/lista-de-convidados-nao-encontrada.error.js';
import { EventoNaoEncontradoError } from '../../../src/errors/evento/nao-encontrado.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { alterarPresencaConvidado } from '../../../src/use-cases/evento/alterar-presenca-convidado.js';
import { atualizarListaDeConvidados } from '../../../src/use-cases/evento/atualizar-lista-de-convidados.js';
import { criarEvento } from '../../../src/use-cases/evento/criar-evento.js';
import { criarListaDeConvidados } from '../../../src/use-cases/evento/criar-lista-de-convidados.js';
import { obterListaDeConvidadosPorId } from '../../../src/use-cases/evento/obter-lista-de-convidados-por-id.js';
import { obterListaDeConvidadosPorIdEvento } from '../../../src/use-cases/evento/obter-lista-de-convidados-por-id-evento.js';
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

async function seedEvento(repos: ReturnType<typeof createEventoMemoryRepos>) {
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
      tipoEvento: 'cha-bebe',
      modalidade: 'presencial',
      dataHora: fixedDate,
      endereco: 'Salao principal',
    },
  );

  return { idCampanha, idEvento };
}

function convidadoBase() {
  return {
    id: randomUUID(),
    nome: 'Mariana',
    numeroCelular: '+55 11 99999-9999',
    presenca: 'talvez' as const,
  };
}

describe('criarListaDeConvidados', () => {
  it('creates list when evento exists', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();

    const lista = await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [convidadoBase()],
      },
    );

    expect(lista.id).toBe(idLista);
    expect(lista.idEvento).toBe(idEvento);
    expect(lista.convidados).toHaveLength(1);

    const loaded = await repos.listaDeConvidadosRepository.findByIdEvento(idEvento);
    expect(loaded?.id).toBe(idLista);
  });

  it('throws EventoNaoEncontradoError when evento is missing', async () => {
    const repos = createEventoMemoryRepos();

    await expect(
      criarListaDeConvidados(
        {
          listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
          eventoRepository: repos.eventoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idEvento: randomUUID(),
          linkConfirmacao: 'https://eunenem.app/rsvp/invalido',
          formatoMensagemConvite: 'texto',
          convidados: [],
        },
      ),
    ).rejects.toBeInstanceOf(EventoNaoEncontradoError);
  });

  it('throws ListaDeConvidadosJaExisteError on second create for same evento', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const deps = {
      listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
      eventoRepository: repos.eventoRepository,
      clock,
      observability: silentObservability,
    };

    await criarListaDeConvidados(deps, {
      id: randomUUID(),
      idEvento,
      linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
      formatoMensagemConvite: 'texto',
      convidados: [],
    });

    await expect(
      criarListaDeConvidados(deps, {
        id: randomUUID(),
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-2',
        formatoMensagemConvite: 'texto',
        convidados: [],
      }),
    ).rejects.toBeInstanceOf(ListaDeConvidadosJaExisteError);
  });
});

describe('obterListaDeConvidados', () => {
  it('obterListaDeConvidadosPorId returns lista', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [],
      },
    );

    const loaded = await obterListaDeConvidadosPorId(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        observability: silentObservability,
      },
      { id: idLista },
    );
    expect(loaded.id).toBe(idLista);
  });

  it('obterListaDeConvidadosPorIdEvento returns lista by evento', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [],
      },
    );

    const loaded = await obterListaDeConvidadosPorIdEvento(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        observability: silentObservability,
      },
      { idEvento },
    );
    expect(loaded.id).toBe(idLista);
  });
});

describe('atualizarListaDeConvidados', () => {
  it('updates fields and guests', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();
    const convidado = convidadoBase();
    const updateClock = () => new Date('2026-06-20T12:00:00.000Z');

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [],
      },
    );

    const updated = await atualizarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        clock: updateClock,
        observability: silentObservability,
      },
      {
        id: idLista,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-atualizada',
        formatoMensagemConvite: 'convite_virtual',
        convidados: [{ ...convidado, presenca: 'sim' }],
      },
    );

    expect(updated.linkConfirmacao).toBe('https://eunenem.app/rsvp/lista-atualizada');
    expect(updated.formatoMensagemConvite).toBe('convite_virtual');
    expect(updated.convidados).toHaveLength(1);
    expect(updated.convidados[0]?.presenca).toBe('sim');
    expect(updated.atualizadoEm).toEqual(updateClock());
  });
});

describe('alterarPresencaConvidado', () => {
  it('updates only one guest presence', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();
    const convidado = convidadoBase();
    const outroConvidado = {
      id: randomUUID(),
      nome: 'Thiago',
      numeroCelular: '+55 11 98888-7777',
      presenca: 'nao' as const,
    };
    const updateClock = () => new Date('2026-06-21T12:00:00.000Z');

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [convidado, outroConvidado],
      },
    );

    const updated = await alterarPresencaConvidado(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        clock: updateClock,
        observability: silentObservability,
      },
      {
        idListaDeConvidados: idLista,
        idConvidado: convidado.id,
        presenca: 'sim',
      },
    );

    expect(updated.convidados.find((item) => item.id === convidado.id)?.presenca).toBe('sim');
    expect(updated.convidados.find((item) => item.id === outroConvidado.id)?.presenca).toBe('nao');
    expect(updated.atualizadoEm).toEqual(updateClock());
  });

  it('transitions a guest from nao_enviado to enviado', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();
    const convidado = { ...convidadoBase(), presenca: 'nao_enviado' as const };
    const updateClock = () => new Date('2026-06-22T12:00:00.000Z');

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [convidado],
      },
    );

    const updated = await alterarPresencaConvidado(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        clock: updateClock,
        observability: silentObservability,
      },
      {
        idListaDeConvidados: idLista,
        idConvidado: convidado.id,
        presenca: 'enviado',
      },
    );

    expect(updated.convidados.find((item) => item.id === convidado.id)?.presenca).toBe('enviado');
  });

  it('throws when guest is missing', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [convidadoBase()],
      },
    );

    await expect(
      alterarPresencaConvidado(
        {
          listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
          clock,
          observability: silentObservability,
        },
        {
          idListaDeConvidados: idLista,
          idConvidado: randomUUID(),
          presenca: 'sim',
        },
      ),
    ).rejects.toBeInstanceOf(ConvidadoNaoEncontradoError);
  });

  it('rejects invalid presence', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idLista = randomUUID();
    const convidado = convidadoBase();

    await criarListaDeConvidados(
      {
        listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idLista,
        idEvento,
        linkConfirmacao: 'https://eunenem.app/rsvp/lista-1',
        formatoMensagemConvite: 'texto',
        convidados: [convidado],
      },
    );

    await expect(
      alterarPresencaConvidado(
        {
          listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
          clock,
          observability: silentObservability,
        },
        {
          idListaDeConvidados: idLista,
          idConvidado: convidado.id,
          presenca: 'pendente' as 'sim',
        },
      ),
    ).rejects.toBeInstanceOf(ListaDeConvidadosInputInvalidoError);
  });

  it('throws when list is missing', async () => {
    const repos = createEventoMemoryRepos();

    await expect(
      obterListaDeConvidadosPorId(
        {
          listaDeConvidadosRepository: repos.listaDeConvidadosRepository,
          observability: silentObservability,
        },
        { id: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(ListaDeConvidadosNaoEncontradaError);
  });
});
