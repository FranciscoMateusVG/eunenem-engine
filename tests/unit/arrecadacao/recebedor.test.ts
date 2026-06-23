import { describe, expect, it } from 'vitest';
import {
  criarNovoRecebedor,
  criarRecebedorInicial,
  desativarRecebedor,
} from '../../../src/domain/arrecadacao/entities/recebedor.js';

const idCampanha = '550e8400-e29b-41d4-a716-446655440001';
const idRecebedor1 = '550e8400-e29b-41d4-a716-446655440003';
const idRecebedor2 = '550e8400-e29b-41d4-a716-446655440004';
const criadaEm = new Date('2026-05-01T12:00:00.000Z');

const dadosPix = {
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
};

describe('criarRecebedorInicial', () => {
  it('creates active receiver', () => {
    const r = criarRecebedorInicial({
      id: idRecebedor1,
      idCampanha,
      dadosRecebedor: dadosPix,
      criadaEm,
    });
    expect(r).toEqual({
      id: idRecebedor1,
      idCampanha,
      dadosRecebedor: dadosPix,
      isActive: true,
      criadaEm,
    });
  });
});

describe('desativarRecebedor', () => {
  it('marks receiver inactive', () => {
    const ativo = criarRecebedorInicial({
      id: idRecebedor1,
      idCampanha,
      dadosRecebedor: dadosPix,
      criadaEm,
    });
    const inativo = desativarRecebedor(ativo);
    expect(inativo.isActive).toBe(false);
    expect(inativo.id).toBe(idRecebedor1);
    expect(inativo.idCampanha).toBe(idCampanha);
  });
});

describe('criarNovoRecebedor', () => {
  it('creates new active receiver for same idCampanha', () => {
    const novosDados = {
      metodo: 'pix' as const,
      nomeTitular: 'Joao',
      tipoChavePix: 'cpf' as const,
      chavePix: '12345678901',
    };
    const novo = criarNovoRecebedor({
      idCampanha,
      dadosRecebedor: novosDados,
      gerarId: () => idRecebedor2,
      criadaEm,
    });
    expect(novo.id).toBe(idRecebedor2);
    expect(novo.idCampanha).toBe(idCampanha);
    expect(novo.isActive).toBe(true);
    expect(novo.dadosRecebedor).toEqual(novosDados);
  });
});
