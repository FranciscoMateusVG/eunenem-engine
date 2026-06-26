import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { DadosRecebimentoRepositoryMemory } from '../../../src/adapters/usuario/dados-recebimento-repository.memory.js';
import { ResgatePendenteRepositoryMemory } from '../../../src/adapters/usuario/resgate-pendente-repository.memory.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { marcarResgatePendente } from '../../../src/use-cases/usuario/marcar-resgate-pendente.js';
import { obterResgatePendente } from '../../../src/use-cases/usuario/obter-resgate-pendente.js';
import { salvarDadosRecebimentoUsuario } from '../../../src/use-cases/usuario/salvar-dados-recebimento-usuario.js';
import { createTestObservability } from '../../helpers/observability.js';
import { describeResgatePendenteRepositoryConformance } from '../../helpers/resgate-pendente-repository.conformance.js';

const DADOS_CONTA: DadosRecebedor = {
  metodo: 'conta',
  nomeTitular: 'Joao Santos',
  cpfTitular: '52998224725',
  celularTitular: '11987654321',
  codigoBanco: '237',
  agencia: '1234',
  agenciaDigito: null,
  conta: '56789',
  contaDigito: '0',
  tipoConta: 'cc',
};

const testObs = createTestObservability();
const silentObs = testObs.observability;

afterAll(async () => {
  await testObs.shutdown();
});

describe('marcarResgatePendente', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('sets the pending marker (readable via obterResgatePendente)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    const idUsuario = randomUUID();
    const { pendenteDesde } = await marcarResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs, clock },
      { idUsuario },
    );
    expect(pendenteDesde).toEqual(clock());
    const found = await obterResgatePendente(
      { resgatePendenteRepository: repo, observability: silentObs },
      idUsuario,
    );
    expect(found).toEqual(clock());
  });

  it('rejects an invalid idUsuario (UsuarioInputInvalidoError)', async () => {
    const repo = new ResgatePendenteRepositoryMemory();
    await expect(
      marcarResgatePendente(
        { resgatePendenteRepository: repo, observability: silentObs, clock },
        { idUsuario: 'not-a-uuid' },
      ),
    ).rejects.toThrow('Input de usuario invalido');
  });
});

describe('salvarDadosRecebimentoUsuario clears the pending marker', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('clears an existing resgate-pendente marker on a successful full save', async () => {
    const dadosRepo = new DadosRecebimentoRepositoryMemory();
    const resgateRepo = new ResgatePendenteRepositoryMemory();
    const idUsuario = randomUUID();

    // User first asks to "preencher depois" → marker set.
    await marcarResgatePendente(
      { resgatePendenteRepository: resgateRepo, observability: silentObs, clock },
      { idUsuario },
    );
    expect(await resgateRepo.obterPendenteDesde(idUsuario)).not.toBeNull();

    // Later they actually fill the receiving data → marker cleared.
    await salvarDadosRecebimentoUsuario(
      {
        dadosRecebimentoRepository: dadosRepo,
        resgatePendenteRepository: resgateRepo,
        observability: silentObs,
        clock,
      },
      { idUsuario, dados: DADOS_CONTA },
    );
    expect(await resgateRepo.obterPendenteDesde(idUsuario)).toBeNull();
    expect(await dadosRepo.findByUsuarioId(idUsuario)).not.toBeUndefined();
  });

  it('is a no-op clear when no marker exists (save still succeeds)', async () => {
    const dadosRepo = new DadosRecebimentoRepositoryMemory();
    const resgateRepo = new ResgatePendenteRepositoryMemory();
    const idUsuario = randomUUID();
    await salvarDadosRecebimentoUsuario(
      {
        dadosRecebimentoRepository: dadosRepo,
        resgatePendenteRepository: resgateRepo,
        observability: silentObs,
        clock,
      },
      { idUsuario, dados: DADOS_CONTA },
    );
    expect(await resgateRepo.obterPendenteDesde(idUsuario)).toBeNull();
  });
});

describeResgatePendenteRepositoryConformance('Memory', {
  factory: () => new ResgatePendenteRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
