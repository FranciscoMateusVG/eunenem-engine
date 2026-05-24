import { describe, expect, it } from 'vitest';
import {
  contribuicaoComContribuinte,
  contribuicaoComValor,
  contribuicaoDisponivel,
  criarContribuicaoDisponivel,
} from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import { AssociarContribuinteContribuicaoInputSchema } from '../../../src/use-cases/arrecadacao/associar-contribuinte-contribuicao.js';
import { CriarContribuicaoInputSchema } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';

const idContribuicao = '550e8400-e29b-41d4-a716-446655440010';
const idCampanha = '550e8400-e29b-41d4-a716-446655440011';
const idOpcaoContribuicao = '550e8400-e29b-41d4-a716-446655440012';
const criadaEm = new Date('2026-05-01T12:00:00.000Z');

describe('CriarContribuicaoInputSchema', () => {
  it('accepts valid admin input', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 8000,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing nome', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      valor: 8000,
    });
    expect(r.success).toBe(false);
  });

  it('rejects zero valor', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe('AssociarContribuinteContribuicaoInputSchema', () => {
  it('accepts valid contributor with email', () => {
    const r = AssociarContribuinteContribuicaoInputSchema.safeParse({
      idContribuicao,
      contribuinte: { nome: 'Ana', email: 'ana@example.com' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const r = AssociarContribuinteContribuicaoInputSchema.safeParse({
      idContribuicao,
      contribuinte: { nome: 'Ana', email: 'not-an-email' },
    });
    expect(r.success).toBe(false);
  });
});

describe('criarContribuicaoDisponivel', () => {
  it('creates disponivel contribution without contributor', () => {
    const c = criarContribuicaoDisponivel({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    expect(c.status).toBe('disponivel');
    expect(c.contribuinte).toBeNull();
    expect(c.nome).toBe('Fralda');
    expect(c.valor).toBe(5000);
  });
});

describe('contribuicaoComContribuinte', () => {
  it('associates contributor and marks indisponivel', () => {
    const disponivel = criarContribuicaoDisponivel({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    const updated = contribuicaoComContribuinte(disponivel, {
      nome: 'Visitante',
      email: 'v@exemplo.com',
    });
    expect(updated.status).toBe('indisponivel');
    expect(updated.contribuinte?.email).toBe('v@exemplo.com');
    expect(contribuicaoDisponivel(disponivel)).toBe(true);
    expect(contribuicaoDisponivel(updated)).toBe(false);
  });

  it('throws when contribution is not disponivel', () => {
    const indisponivel = contribuicaoComContribuinte(
      criarContribuicaoDisponivel({
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao,
        nome: 'Fralda',
        valor: 5000,
        criadaEm,
      }),
      { nome: 'A', email: 'a@exemplo.com' },
    );
    expect(() =>
      contribuicaoComContribuinte(indisponivel, {
        nome: 'B',
        email: 'b@exemplo.com',
      }),
    ).toThrow();
  });
});

describe('contribuicaoComValor', () => {
  it('updates valor when disponivel', () => {
    const disponivel = criarContribuicaoDisponivel({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    const updated = contribuicaoComValor(disponivel, 9000);
    expect(updated.valor).toBe(9000);
  });
});
