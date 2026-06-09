import { describe, expect, it } from 'vitest';
import {
  contribuicaoAtualizada,
  criarContribuicao,
} from '../../../src/domain/arrecadacao/entities/contribuicao.js';

/**
 * Plan 0016 Phase 1 (aperture-aj8qw) — Contribuição.quantidade tests.
 *
 * Coverage:
 *   - criarContribuicao defaults quantidade=1 when omitted
 *   - criarContribuicao honours explicit positive integer quantidade
 *   - criarContribuicao rejects zero / negative / non-integer
 *   - contribuicaoAtualizada patches quantidade
 *   - contribuicaoAtualizada preserves quantidade when patch omits it
 *   - contribuicaoAtualizada rejects invalid patch values
 */

const ID_CONTRIBUICAO = '550e8400-e29b-41d4-a716-446655441001';
const ID_CAMPANHA = '550e8400-e29b-41d4-a716-446655441002';
const ID_OPCAO = '550e8400-e29b-41d4-a716-446655441003';

const CRIADA_EM = new Date('2026-06-08T12:00:00.000Z');

function baseParams() {
  return {
    id: ID_CONTRIBUICAO,
    idCampanha: ID_CAMPANHA,
    idOpcaoContribuicao: ID_OPCAO,
    nome: 'Taça de vinho',
    valor: 5000,
    criadaEm: CRIADA_EM,
  };
}

describe('criarContribuicao — quantidade', () => {
  it('defaulta quantidade=1 quando omitido', () => {
    const c = criarContribuicao(baseParams());
    expect(c.quantidade).toBe(1);
  });

  it('honra quantidade explícito positivo', () => {
    const c = criarContribuicao({ ...baseParams(), quantidade: 5 });
    expect(c.quantidade).toBe(5);
  });

  it('rejeita quantidade = 0', () => {
    expect(() => criarContribuicao({ ...baseParams(), quantidade: 0 })).toThrow(/inteiro positivo/);
  });

  it('rejeita quantidade negativa', () => {
    expect(() => criarContribuicao({ ...baseParams(), quantidade: -3 })).toThrow(
      /inteiro positivo/,
    );
  });

  it('rejeita quantidade não-inteira', () => {
    expect(() => criarContribuicao({ ...baseParams(), quantidade: 1.5 })).toThrow(
      /inteiro positivo/,
    );
  });
});

describe('contribuicaoAtualizada — quantidade', () => {
  const original = criarContribuicao({ ...baseParams(), quantidade: 5 });

  it('preserva quantidade quando patch a omite', () => {
    const patched = contribuicaoAtualizada(original, { nome: 'Renomeado' });
    expect(patched.quantidade).toBe(5);
    expect(patched.nome).toBe('Renomeado');
  });

  it('aplica quantidade quando patch a fornece', () => {
    const patched = contribuicaoAtualizada(original, { quantidade: 10 });
    expect(patched.quantidade).toBe(10);
  });

  it('aceita baixa do quantidade abaixo do count vendido (overshoot é OK per locked decision #10)', () => {
    // Domain-level: a baixa de quantidade=5 para quantidade=2 é OK.
    // O comportamento "vendi 3 mas slot só tem 2" se manifesta como
    // quantidadeRestante negativo no use-case (Phase 2), não como
    // erro de entidade.
    const patched = contribuicaoAtualizada(original, { quantidade: 2 });
    expect(patched.quantidade).toBe(2);
  });

  it('rejeita patch com quantidade = 0', () => {
    expect(() => contribuicaoAtualizada(original, { quantidade: 0 })).toThrow(/inteiro positivo/);
  });

  it('rejeita patch com quantidade não-inteira', () => {
    expect(() => contribuicaoAtualizada(original, { quantidade: 2.7 })).toThrow(
      /inteiro positivo/,
    );
  });
});
