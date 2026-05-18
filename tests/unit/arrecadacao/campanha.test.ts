import { describe, expect, it } from 'vitest';
import {
  CriarCampanhaInputSchema,
  campanhaComOpcao,
  encontrarOpcaoContribuicao,
} from '../../../src/domain/arrecadacao/campanha.js';

const idCampanha = '550e8400-e29b-41d4-a716-446655440001';
const idContaCriadora = '550e8400-e29b-41d4-a716-446655440002';
const idRecebedor = '550e8400-e29b-41d4-a716-446655440003';
const idOpcao = '550e8400-e29b-41d4-a716-446655440004';

describe('CriarCampanhaInputSchema', () => {
  it('accepts valid input', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idContaCriadora,
      idRecebedor,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty title', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idContaCriadora,
      idRecebedor,
      titulo: '   ',
    });
    expect(r.success).toBe(false);
  });
});

describe('encontrarOpcaoContribuicao', () => {
  it('returns the option when present', () => {
    const opcao = { id: idOpcao, amountCents: 8000, rotulo: 'Valor sugerido' };
    const campanha = {
      id: idCampanha,
      idContaCriadora,
      idRecebedor,
      titulo: 'Campanha',
      opcoes: [opcao],
      criadaEm: new Date(),
    };
    expect(encontrarOpcaoContribuicao(campanha, idOpcao)).toEqual(opcao);
  });

  it('returns undefined when missing', () => {
    const campanha = {
      id: idCampanha,
      idContaCriadora,
      idRecebedor,
      titulo: 'Campanha',
      opcoes: [],
      criadaEm: new Date(),
    };
    expect(encontrarOpcaoContribuicao(campanha, idOpcao)).toBeUndefined();
  });
});

describe('campanhaComOpcao', () => {
  it('appends option immutably', () => {
    const base = {
      id: idCampanha,
      idContaCriadora,
      idRecebedor,
      titulo: 'Campanha',
      opcoes: [] as const,
      criadaEm: new Date('2026-01-01T00:00:00.000Z'),
    };
    const opcao = { id: idOpcao, amountCents: 5000 };
    const next = campanhaComOpcao(base, opcao);
    expect(base.opcoes).toHaveLength(0);
    expect(next.opcoes).toHaveLength(1);
    expect(next.opcoes[0]).toEqual(opcao);
  });
});
