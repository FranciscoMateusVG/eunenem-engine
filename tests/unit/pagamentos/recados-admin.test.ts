/**
 * aperture-16wrk / 5v766 Phase A — admin mensagens backend.
 *
 * Use-case-level tests:
 *   (A) obterRecadosAdminDeCampanha
 *       - projects aprovado-with-mensagem rows
 *       - decorates contribuicaoNome from contribuicao repository
 *       - computes todas / naoLidas counts
 *       - excludes pendente, anonymous, empty-mensagem rows
 *       - empty result when no recados
 *   (B) marcarRecadoComoLido
 *       - first call flips lidaEm and returns new timestamp
 *       - second call returns the ORIGINAL timestamp (first-write-wins)
 *       - throws PagamentoNaoEncontradoError on unknown id
 *   (C) marcarTodosRecadosComoLidos
 *       - flips all unread aprovado-with-mensagem rows, returns count
 *       - skips already-read rows
 *       - only target campanha is touched
 *
 * Memory adapter is the substrate. The postgres adapter shares the
 * same port interface; parity is implicit via the typed contract.
 */

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import type { Contribuicao } from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../../src/domain/arrecadacao/value-objects/ids.js';
import type { IdPagamento } from '../../../src/domain/pagamentos/value-objects/ids.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';
import { marcarRecadoComoLido } from '../../../src/use-cases/pagamentos/marcar-recado-como-lido.js';
import { marcarTodosRecadosComoLidos } from '../../../src/use-cases/pagamentos/marcar-todos-recados-como-lidos.js';
import { obterRecadosAdminDeCampanha } from '../../../src/use-cases/pagamentos/obter-recados-admin-de-campanha.js';
import { createTestObservability } from '../../helpers/observability.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const { observability } = createTestObservability();

function makeContribuicao(args: {
  id: IdContribuicao;
  idCampanha: IdCampanha;
  nome: string;
}): Contribuicao {
  return {
    id: args.id,
    idCampanha: args.idCampanha,
    idOpcaoContribuicao: randomUUID() as IdOpcaoContribuicao,
    nome: args.nome,
    valor: 8000,
    quantidade: 1,
    grupo: null,
    imagemUrl: null,
    criadaEm: new Date('2026-06-10T00:00:00.000Z'),
  };
}

interface Setup {
  pagamentoRepository: PagamentoRepositoryMemory;
  contribuicaoRepository: ContribuicaoRepositoryMemory;
  idCampanha: IdCampanha;
  idContribuicao: IdContribuicao;
}

async function setup(): Promise<Setup> {
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const idCampanha = randomUUID() as IdCampanha;
  const idContribuicao = randomUUID() as IdContribuicao;
  await contribuicaoRepository.save(
    makeContribuicao({ id: idContribuicao, idCampanha, nome: 'Fralda P' }),
  );
  return { pagamentoRepository, contribuicaoRepository, idCampanha, idContribuicao };
}

describe('obterRecadosAdminDeCampanha (aperture-16wrk)', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('projects aprovado-with-mensagem rows and decorates contribuicaoNome', async () => {
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        criadoEm: new Date('2026-06-10T10:00:00.000Z'),
        contribuinte: {
          nome: 'Tia Rosângela',
          email: 'tia@example.com',
          mensagem: 'Parabéns!',
        },
      }),
    );

    const result = await obterRecadosAdminDeCampanha(
      {
        pagamentoRepository: s.pagamentoRepository,
        contribuicaoRepository: s.contribuicaoRepository,
        observability,
      },
      s.idCampanha,
    );

    expect(result.recados).toHaveLength(1);
    const r = result.recados[0];
    expect(r).toBeDefined();
    if (!r) throw new Error('expected recados[0] to be defined');
    expect(r.contribuinteNome).toBe('Tia Rosângela');
    expect(r.mensagem).toBe('Parabéns!');
    expect(r.lidaEm).toBeNull();
    expect(r.valorContribuicaoCents).toBeGreaterThan(0);
    expect(r.contribuicaoNome).toBe('Fralda P');
    expect(result.counts).toEqual({ todas: 1, naoLidas: 1 });
  });

  it('counts naoLidas correctly when some recados are already read', async () => {
    const id1 = randomUUID() as IdPagamento;
    const id2 = randomUUID() as IdPagamento;
    await s.pagamentoRepository.save(
      makePagamento({
        id: id1,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        criadoEm: new Date('2026-06-10T10:00:00.000Z'),
        contribuinte: { nome: 'A', email: 'a@x.com', mensagem: 'hi' },
      }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        id: id2,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        criadoEm: new Date('2026-06-10T11:00:00.000Z'),
        contribuinte: { nome: 'B', email: 'b@x.com', mensagem: 'hello' },
      }),
    );
    await s.pagamentoRepository.marcarRecadoLido(id1, new Date('2026-06-10T12:00:00.000Z'));

    const result = await obterRecadosAdminDeCampanha(
      {
        pagamentoRepository: s.pagamentoRepository,
        contribuicaoRepository: s.contribuicaoRepository,
        observability,
      },
      s.idCampanha,
    );

    expect(result.counts).toEqual({ todas: 2, naoLidas: 1 });
    // Newest first.
    expect(result.recados[0]?.contribuinteNome).toBe('B');
    expect(result.recados[0]?.lidaEm).toBeNull();
    expect(result.recados[1]?.contribuinteNome).toBe('A');
    expect(result.recados[1]?.lidaEm).toBe('2026-06-10T12:00:00.000Z');
  });

  it('excludes pendente, anonymous, and empty-mensagem rows', async () => {
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'pendente',
        contribuinte: { nome: 'A', email: 'a@x.com', mensagem: 'hi' },
      }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: null,
      }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'B', email: 'b@x.com' },
      }),
    );

    const result = await obterRecadosAdminDeCampanha(
      {
        pagamentoRepository: s.pagamentoRepository,
        contribuicaoRepository: s.contribuicaoRepository,
        observability,
      },
      s.idCampanha,
    );

    expect(result.recados).toHaveLength(0);
    expect(result.counts).toEqual({ todas: 0, naoLidas: 0 });
  });

  it('returns empty when no recados exist on the campanha', async () => {
    const result = await obterRecadosAdminDeCampanha(
      {
        pagamentoRepository: s.pagamentoRepository,
        contribuicaoRepository: s.contribuicaoRepository,
        observability,
      },
      s.idCampanha,
    );
    expect(result.recados).toEqual([]);
    expect(result.counts).toEqual({ todas: 0, naoLidas: 0 });
  });

  it('decorates contribuicaoNome as null when the row was deleted', async () => {
    const danglingContribuicao = randomUUID() as IdContribuicao;
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: danglingContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'C', email: 'c@x.com', mensagem: 'hi' },
      }),
    );

    const result = await obterRecadosAdminDeCampanha(
      {
        pagamentoRepository: s.pagamentoRepository,
        contribuicaoRepository: s.contribuicaoRepository,
        observability,
      },
      s.idCampanha,
    );
    expect(result.recados).toHaveLength(1);
    expect(result.recados[0]?.contribuicaoNome).toBeNull();
  });
});

describe('marcarRecadoComoLido (aperture-16wrk)', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('first call flips lidaEm and returns new timestamp', async () => {
    const id = randomUUID() as IdPagamento;
    await s.pagamentoRepository.save(
      makePagamento({
        id,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'A', email: 'a@x.com', mensagem: 'hi' },
      }),
    );

    const t1 = new Date('2026-06-10T12:00:00.000Z');
    const result = await marcarRecadoComoLido(
      { pagamentoRepository: s.pagamentoRepository, observability },
      id,
      t1,
    );
    expect(result.lidaEm).toBe('2026-06-10T12:00:00.000Z');
  });

  it('second call returns ORIGINAL timestamp (first-write-wins)', async () => {
    const id = randomUUID() as IdPagamento;
    await s.pagamentoRepository.save(
      makePagamento({
        id,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'A', email: 'a@x.com', mensagem: 'hi' },
      }),
    );

    const t1 = new Date('2026-06-10T12:00:00.000Z');
    const t2 = new Date('2026-06-10T15:00:00.000Z');
    await marcarRecadoComoLido(
      { pagamentoRepository: s.pagamentoRepository, observability },
      id,
      t1,
    );
    const second = await marcarRecadoComoLido(
      { pagamentoRepository: s.pagamentoRepository, observability },
      id,
      t2,
    );
    expect(second.lidaEm).toBe('2026-06-10T12:00:00.000Z');
  });

  it('throws PagamentoNaoEncontradoError when id is unknown', async () => {
    await expect(
      marcarRecadoComoLido(
        { pagamentoRepository: s.pagamentoRepository, observability },
        randomUUID() as IdPagamento,
        new Date(),
      ),
    ).rejects.toBeInstanceOf(PagamentoNaoEncontradoError);
  });
});

describe('marcarTodosRecadosComoLidos (aperture-16wrk)', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('flips all unread aprovado-with-mensagem rows and returns count', async () => {
    for (let i = 0; i < 3; i++) {
      await s.pagamentoRepository.save(
        makePagamento({
          idContribuicao: s.idContribuicao,
          idCampanha: s.idCampanha,
          status: 'aprovado',
          contribuinte: { nome: `U${i}`, email: `u${i}@x.com`, mensagem: 'hi' },
        }),
      );
    }

    const result = await marcarTodosRecadosComoLidos(
      { pagamentoRepository: s.pagamentoRepository, observability },
      s.idCampanha,
      new Date('2026-06-10T12:00:00.000Z'),
    );
    expect(result.marcadas).toBe(3);

    // Re-call returns 0 (idempotent).
    const second = await marcarTodosRecadosComoLidos(
      { pagamentoRepository: s.pagamentoRepository, observability },
      s.idCampanha,
      new Date('2026-06-10T15:00:00.000Z'),
    );
    expect(second.marcadas).toBe(0);
  });

  it('skips already-read rows', async () => {
    const id1 = randomUUID() as IdPagamento;
    const id2 = randomUUID() as IdPagamento;
    await s.pagamentoRepository.save(
      makePagamento({
        id: id1,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'A', email: 'a@x.com', mensagem: 'hi' },
      }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        id: id2,
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'B', email: 'b@x.com', mensagem: 'hi' },
      }),
    );
    await s.pagamentoRepository.marcarRecadoLido(id1, new Date('2026-06-10T10:00:00.000Z'));

    const result = await marcarTodosRecadosComoLidos(
      { pagamentoRepository: s.pagamentoRepository, observability },
      s.idCampanha,
      new Date('2026-06-10T12:00:00.000Z'),
    );
    expect(result.marcadas).toBe(1);
  });

  it('only target campanha is touched', async () => {
    const otherCampanha = randomUUID() as IdCampanha;
    const otherContribuicao = randomUUID() as IdContribuicao;
    await s.contribuicaoRepository.save(
      makeContribuicao({ id: otherContribuicao, idCampanha: otherCampanha, nome: 'X' }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: otherContribuicao,
        idCampanha: otherCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'X', email: 'x@x.com', mensagem: 'hi' },
      }),
    );
    await s.pagamentoRepository.save(
      makePagamento({
        idContribuicao: s.idContribuicao,
        idCampanha: s.idCampanha,
        status: 'aprovado',
        contribuinte: { nome: 'Y', email: 'y@x.com', mensagem: 'hi' },
      }),
    );

    const result = await marcarTodosRecadosComoLidos(
      { pagamentoRepository: s.pagamentoRepository, observability },
      s.idCampanha,
      new Date('2026-06-10T12:00:00.000Z'),
    );
    expect(result.marcadas).toBe(1);

    // Confirm other campanha is still unread.
    const other = await s.pagamentoRepository.findRecadosAdminByCampanha(otherCampanha);
    expect(other).toHaveLength(1);
    expect(other[0]?.lidaEm).toBeNull();
  });
});
