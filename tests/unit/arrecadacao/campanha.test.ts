import { describe, expect, it } from 'vitest';
import {
  CriarCampanhaInputSchema,
  campanhaComAdministrador,
  campanhaComOpcao,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
  encontrarOpcaoContribuicao,
} from '../../../src/domain/arrecadacao/campanha.js';

const idCampanha = '550e8400-e29b-41d4-a716-446655440001';
const idAdministrador1 = '550e8400-e29b-41d4-a716-446655440002';
const idAdministrador2 = '550e8400-e29b-41d4-a716-446655440005';
const idRecebedor = '550e8400-e29b-41d4-a716-446655440003';
const idOpcao = '550e8400-e29b-41d4-a716-446655440004';

const baseCampanha = {
  id: idCampanha,
  idsAdministradores: [idAdministrador1] as const,
  idRecebedor,
  titulo: 'Campanha',
  opcoes: [] as const,
  criadaEm: new Date('2026-01-01T00:00:00.000Z'),
};

describe('CriarCampanhaInputSchema', () => {
  it('accepts valid input with one administrator', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1],
      idRecebedor,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('accepts valid input with multiple administrators', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1, idAdministrador2],
      idRecebedor,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty administrators array', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [],
      idRecebedor,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate administrator ids', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1, idAdministrador1],
      idRecebedor,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty title', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1],
      idRecebedor,
      titulo: '   ',
    });
    expect(r.success).toBe(false);
  });
});

describe('campanhaPossuiAdministrador', () => {
  it('returns true when account is administrator', () => {
    expect(campanhaPossuiAdministrador(baseCampanha, idAdministrador1)).toBe(true);
  });

  it('returns false when account is not administrator', () => {
    expect(campanhaPossuiAdministrador(baseCampanha, idAdministrador2)).toBe(false);
  });
});

describe('campanhaComAdministrador', () => {
  it('appends administrator immutably', () => {
    const next = campanhaComAdministrador(baseCampanha, idAdministrador2);
    expect(baseCampanha.idsAdministradores).toHaveLength(1);
    expect(next.idsAdministradores).toEqual([idAdministrador1, idAdministrador2]);
  });
});

describe('campanhaSemAdministrador', () => {
  it('removes administrator immutably', () => {
    const withTwo = campanhaComAdministrador(baseCampanha, idAdministrador2);
    const next = campanhaSemAdministrador(withTwo, idAdministrador2);
    expect(withTwo.idsAdministradores).toHaveLength(2);
    expect(next.idsAdministradores).toEqual([idAdministrador1]);
  });
});

describe('encontrarOpcaoContribuicao', () => {
  it('returns the option when present', () => {
    const opcao = { id: idOpcao, amountCents: 8000, rotulo: 'Valor sugerido' };
    const campanha = {
      ...baseCampanha,
      opcoes: [opcao],
    };
    expect(encontrarOpcaoContribuicao(campanha, idOpcao)).toEqual(opcao);
  });

  it('returns undefined when missing', () => {
    expect(encontrarOpcaoContribuicao(baseCampanha, idOpcao)).toBeUndefined();
  });
});

describe('campanhaComOpcao', () => {
  it('appends option immutably', () => {
    const opcao = { id: idOpcao, amountCents: 5000 };
    const next = campanhaComOpcao(baseCampanha, opcao);
    expect(baseCampanha.opcoes).toHaveLength(0);
    expect(next.opcoes).toHaveLength(1);
    expect(next.opcoes[0]).toEqual(opcao);
  });
});
