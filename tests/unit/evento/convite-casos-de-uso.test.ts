import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../../src/domain/arrecadacao/entities/campanha.js';
import { ConviteInputInvalidoError } from '../../../src/errors/evento/convite-input-invalido.error.js';
import { ConviteJaExisteError } from '../../../src/errors/evento/convite-ja-existe.error.js';
import { ConviteNaoEncontradoError } from '../../../src/errors/evento/convite-nao-encontrado.error.js';
import { EventoNaoEncontradoError } from '../../../src/errors/evento/nao-encontrado.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { atualizarConvite } from '../../../src/use-cases/evento/atualizar-convite.js';
import { criarConvite } from '../../../src/use-cases/evento/criar-convite.js';
import { criarEvento } from '../../../src/use-cases/evento/criar-evento.js';
import { obterConvitePorId } from '../../../src/use-cases/evento/obter-convite-por-id.js';
import { obterConvitePorIdEvento } from '../../../src/use-cases/evento/obter-convite-por-id-evento.js';
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

describe('criarConvite', () => {
  it('creates invite when evento exists', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idConvite = randomUUID();

    const convite = await criarConvite(
      {
        conviteRepository: repos.conviteRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        idEvento,
        nomeExibido: 'Maria Helena',
        mensagem: 'Esperamos voce para esse dia especial.',
        paleta: 'lilas',
        fonte: 'patrick',
        modelo: 'scrapbook',
        imagem: 'https://cdn.example.com/convites/maria-helena.png',
      },
    );

    expect(convite.id).toBe(idConvite);
    expect(convite.idEvento).toBe(idEvento);
    expect(convite.nomeExibido).toBe('Maria Helena');
    expect(convite.imagem).toBe('https://cdn.example.com/convites/maria-helena.png');

    const loaded = await repos.conviteRepository.findByIdEvento(idEvento);
    expect(loaded?.id).toBe(idConvite);
    expect(loaded?.imagem).toBe('https://cdn.example.com/convites/maria-helena.png');
  });

  it('throws EventoNaoEncontradoError when evento is missing', async () => {
    const repos = createEventoMemoryRepos();

    await expect(
      criarConvite(
        {
          conviteRepository: repos.conviteRepository,
          eventoRepository: repos.eventoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idEvento: randomUUID(),
          nomeExibido: 'Maria Helena',
          mensagem: 'Mensagem valida',
          paleta: 'lilas',
          fonte: 'patrick',
          modelo: 'scrapbook',
        },
      ),
    ).rejects.toBeInstanceOf(EventoNaoEncontradoError);
  });

  it('throws ConviteJaExisteError on second create for same evento', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const deps = {
      conviteRepository: repos.conviteRepository,
      eventoRepository: repos.eventoRepository,
      clock,
      observability: silentObservability,
    };
    const base = {
      idEvento,
      nomeExibido: 'Maria Helena',
      mensagem: 'Mensagem valida',
      paleta: 'lilas' as const,
      fonte: 'patrick' as const,
      modelo: 'scrapbook' as const,
    };

    await criarConvite(deps, { ...base, id: randomUUID() });

    await expect(criarConvite(deps, { ...base, id: randomUUID() })).rejects.toBeInstanceOf(
      ConviteJaExisteError,
    );
  });

  it('rejects non-url image reference', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);

    await expect(
      criarConvite(
        {
          conviteRepository: repos.conviteRepository,
          eventoRepository: repos.eventoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idEvento,
          nomeExibido: 'Maria Helena',
          mensagem: 'Mensagem valida',
          paleta: 'lilas',
          fonte: 'patrick',
          modelo: 'scrapbook',
          imagem: '/convites/maria-helena.png',
        },
      ),
    ).rejects.toBeInstanceOf(ConviteInputInvalidoError);
  });
});

describe('obterConvite', () => {
  it('obterConvitePorId returns convite', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idConvite = randomUUID();

    await criarConvite(
      {
        conviteRepository: repos.conviteRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        idEvento,
        nomeExibido: 'Maria Helena',
        mensagem: 'Mensagem valida',
        paleta: 'lilas',
        fonte: 'patrick',
        modelo: 'scrapbook',
        imagem: 'https://cdn.example.com/convites/maria.png',
      },
    );

    const loaded = await obterConvitePorId(
      { conviteRepository: repos.conviteRepository, observability: silentObservability },
      { id: idConvite },
    );
    expect(loaded.id).toBe(idConvite);
  });

  it('obterConvitePorIdEvento returns convite by evento', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idConvite = randomUUID();

    await criarConvite(
      {
        conviteRepository: repos.conviteRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        idEvento,
        nomeExibido: 'Theo',
        mensagem: 'Mensagem valida',
        paleta: 'surpresa',
        fonte: 'caveat',
        modelo: 'safari',
        imagem: 'https://cdn.example.com/convites/theo.jpg',
      },
    );

    const loaded = await obterConvitePorIdEvento(
      { conviteRepository: repos.conviteRepository, observability: silentObservability },
      { idEvento },
    );
    expect(loaded.id).toBe(idConvite);
  });

  it('obterConvitePorId throws when missing', async () => {
    const repos = createEventoMemoryRepos();

    await expect(
      obterConvitePorId(
        { conviteRepository: repos.conviteRepository, observability: silentObservability },
        { id: randomUUID() },
      ),
    ).rejects.toBeInstanceOf(ConviteNaoEncontradoError);
  });
});

describe('atualizarConvite', () => {
  it('updates fields and bumps atualizadoEm', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idConvite = randomUUID();
    const updateClock = () => new Date('2026-06-20T12:00:00.000Z');

    await criarConvite(
      {
        conviteRepository: repos.conviteRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        idEvento,
        nomeExibido: 'Maria Helena',
        mensagem: 'Mensagem inicial',
        paleta: 'lilas',
        fonte: 'patrick',
        modelo: 'scrapbook',
        imagem: 'https://cdn.example.com/convites/inicial.png',
      },
    );

    const updated = await atualizarConvite(
      {
        conviteRepository: repos.conviteRepository,
        clock: updateClock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        nomeExibido: 'Theo',
        mensagem: 'Mensagem atualizada',
        paleta: 'amarelo',
        fonte: 'caveat',
        modelo: 'elefantinho',
        imagem: 'https://cdn.example.com/convites/theo.jpg',
      },
    );

    expect(updated.nomeExibido).toBe('Theo');
    expect(updated.paleta).toBe('amarelo');
    expect(updated.fonte).toBe('caveat');
    expect(updated.modelo).toBe('elefantinho');
    expect(updated.imagem).toBe('https://cdn.example.com/convites/theo.jpg');
    expect(updated.atualizadoEm).toEqual(updateClock());
  });

  it('rejects invalid palette', async () => {
    const repos = createEventoMemoryRepos();
    const { idEvento } = await seedEvento(repos);
    const idConvite = randomUUID();

    await criarConvite(
      {
        conviteRepository: repos.conviteRepository,
        eventoRepository: repos.eventoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idConvite,
        idEvento,
        nomeExibido: 'Maria Helena',
        mensagem: 'Mensagem inicial',
        paleta: 'lilas',
        fonte: 'patrick',
        modelo: 'scrapbook',
        imagem: 'https://cdn.example.com/convites/maria.png',
      },
    );

    await expect(
      atualizarConvite(
        {
          conviteRepository: repos.conviteRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: idConvite,
          nomeExibido: 'Maria Helena',
          mensagem: 'Mensagem atualizada',
          paleta: 'coral' as 'lilas',
          fonte: 'patrick',
          modelo: 'scrapbook',
        },
      ),
    ).rejects.toBeInstanceOf(ConviteInputInvalidoError);
  });
});
