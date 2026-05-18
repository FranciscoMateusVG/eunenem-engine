import { describe, expect, it } from 'vitest';
import { CriarContribuicaoInputSchema } from '../../../src/domain/arrecadacao/contribuicao.js';

const idContribuicao = '550e8400-e29b-41d4-a716-446655440010';
const idCampanha = '550e8400-e29b-41d4-a716-446655440011';
const idOpcaoContribuicao = '550e8400-e29b-41d4-a716-446655440012';

describe('CriarContribuicaoInputSchema', () => {
  it('accepts valid contributor', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      contribuinte: { nomeExibicao: 'Ana' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts optional email', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      contribuinte: { nomeExibicao: 'Ana', email: 'ana@example.com' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const r = CriarContribuicaoInputSchema.safeParse({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      contribuinte: { nomeExibicao: 'Ana', email: 'not-an-email' },
    });
    expect(r.success).toBe(false);
  });
});
