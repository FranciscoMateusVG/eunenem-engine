import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { DadosRecebimentoRepositoryMemory } from '../../../src/adapters/usuario/dados-recebimento-repository.memory.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import {
  atualizarDadosRecebimentoUsuario,
  criarDadosRecebimentoUsuario,
} from '../../../src/domain/usuario/entities/dados-recebimento-usuario.js';
import { obterDadosRecebimentoUsuario } from '../../../src/use-cases/usuario/obter-dados-recebimento-usuario.js';
import { salvarDadosRecebimentoUsuario } from '../../../src/use-cases/usuario/salvar-dados-recebimento-usuario.js';
import { describeDadosRecebimentoRepositoryConformance } from '../../helpers/dados-recebimento-repository.conformance.js';
import { createTestObservability } from '../../helpers/observability.js';

const DADOS_PIX: DadosRecebedor = {
  metodo: 'pix',
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email',
  chavePix: 'maria@exemplo.com',
};

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

describe('criarDadosRecebimentoUsuario / atualizarDadosRecebimentoUsuario', () => {
  it('creates a registro carrying the dados + atualizadoEm', () => {
    const atualizadoEm = new Date('2026-06-01T12:00:00.000Z');
    const registro = criarDadosRecebimentoUsuario({
      idUsuario: '22222222-2222-2222-2222-222222222222',
      dados: DADOS_PIX,
      atualizadoEm,
    });
    expect(registro.dados).toEqual(DADOS_PIX);
    expect(registro.atualizadoEm).toEqual(atualizadoEm);
  });

  it('replaces dados and bumps atualizadoEm, preserving idUsuario (pure)', () => {
    const registro = criarDadosRecebimentoUsuario({
      idUsuario: '22222222-2222-2222-2222-222222222222',
      dados: DADOS_PIX,
      atualizadoEm: new Date('2026-06-01T12:00:00.000Z'),
    });
    const novoEm = new Date('2026-06-10T08:00:00.000Z');
    const atualizado = atualizarDadosRecebimentoUsuario(registro, {
      dados: DADOS_CONTA,
      atualizadoEm: novoEm,
    });
    expect(atualizado.idUsuario).toBe(registro.idUsuario);
    expect(atualizado.dados).toEqual(DADOS_CONTA);
    expect(atualizado.atualizadoEm).toEqual(novoEm);
    // original untouched
    expect(registro.dados).toEqual(DADOS_PIX);
  });
});

describe('salvarDadosRecebimentoUsuario', () => {
  const clock = () => new Date('2026-06-15T00:00:00.000Z');

  it('persists a valid conta variant and returns the registro', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    const idUsuario = randomUUID();
    const registro = await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: DADOS_CONTA },
    );
    expect(registro.dados).toEqual(DADOS_CONTA);
    expect(await repo.findByUsuarioId(idUsuario)).toEqual(registro);
  });

  it('rejects a conta variant with a bad CPF (UsuarioInputInvalidoError)', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    await expect(
      salvarDadosRecebimentoUsuario(
        { dadosRecebimentoRepository: repo, observability: silentObs, clock },
        { idUsuario: randomUUID(), dados: { ...DADOS_CONTA, cpfTitular: '12345678901' } },
      ),
    ).rejects.toThrow('Input de usuario invalido');
  });

  it('upserts: a second save replaces the dados', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    const idUsuario = randomUUID();
    await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: DADOS_PIX },
    );
    await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: DADOS_CONTA },
    );
    const found = await repo.findByUsuarioId(idUsuario);
    expect(found?.dados).toEqual(DADOS_CONTA);
  });

  // aperture-3mlcw — CPF immutability (backend defense-in-depth)
  it('rejects changing an already-saved cpfTitular to a different value', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    const idUsuario = randomUUID();
    await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: DADOS_CONTA },
    );
    // '11144477735' is a DIFFERENT but checksum-valid CPF — it passes schema
    // validation and reaches the immutability guard, which must reject it.
    await expect(
      salvarDadosRecebimentoUsuario(
        { dadosRecebimentoRepository: repo, observability: silentObs, clock },
        { idUsuario, dados: { ...DADOS_CONTA, cpfTitular: '11144477735' } },
      ),
    ).rejects.toThrow('CPF do titular nao pode ser alterado');
    // unchanged on disk
    const found = await repo.findByUsuarioId(idUsuario);
    expect(found?.dados.metodo === 'conta' && found.dados.cpfTitular).toBe(
      DADOS_CONTA.metodo === 'conta' ? DADOS_CONTA.cpfTitular : '',
    );
  });

  it('allows re-saving the SAME cpfTitular while changing other fields', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    const idUsuario = randomUUID();
    await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: DADOS_CONTA },
    );
    const updated = await salvarDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs, clock },
      { idUsuario, dados: { ...DADOS_CONTA, agencia: '9999' } },
    );
    expect(updated.dados.metodo === 'conta' && updated.dados.agencia).toBe('9999');
  });
});

describe('obterDadosRecebimentoUsuario', () => {
  it('returns undefined when nothing saved', async () => {
    const repo = new DadosRecebimentoRepositoryMemory();
    const result = await obterDadosRecebimentoUsuario(
      { dadosRecebimentoRepository: repo, observability: silentObs },
      randomUUID(),
    );
    expect(result).toBeUndefined();
  });
});

describeDadosRecebimentoRepositoryConformance('Memory', {
  factory: () => new DadosRecebimentoRepositoryMemory(),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'memory',
});
