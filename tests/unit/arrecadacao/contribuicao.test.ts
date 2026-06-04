import { describe, expect, it } from 'vitest';
import {
  contribuicaoAtualizada,
  criarContribuicao,
} from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import { CriarContribuicaoInputSchema } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';

/**
 * Plan 0015 (aperture-ucgok). Rewritten for the slimmed Contribuição:
 *   - No status, no contribuinte, no transitions
 *   - `criarContribuicaoDisponivel` renamed to `criarContribuicao`
 *   - `contribuicaoComContribuinte` / `contribuicaoComValor` / etc gone
 *   - The AssociarContribuinteContribuicao use-case was deleted (Phase 1)
 *
 * The contribuinte-related tests moved to:
 *   - Pagamentos repository tests (contribuinte snapshot on IntencaoPagamento)
 *   - finalizar-pagamento-aprovado tests (webhook stamps it at finalize)
 */

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

describe('criarContribuicao (entity factory)', () => {
  it('creates a slot definition (no status, no contribuinte)', () => {
    const c = criarContribuicao({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    expect(c.nome).toBe('Fralda');
    expect(c.valor).toBe(5000);
    expect(c.id).toBe(idContribuicao);
    expect(c.criadaEm).toBe(criadaEm);
    expect(c.imagemUrl).toBeNull();
    expect(c.grupo).toBeNull();
    // No status field anymore — predicate check.
    expect(c).not.toHaveProperty('status');
    expect(c).not.toHaveProperty('contribuinte');
  });

  it('honors optional imagemUrl and grupo', () => {
    const c = criarContribuicao({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      imagemUrl: 'https://cdn.example.com/fralda.png',
      grupo: 'vestuario',
      criadaEm,
    });
    expect(c.imagemUrl).toBe('https://cdn.example.com/fralda.png');
    expect(c.grupo).toBe('vestuario');
  });
});

describe('contribuicaoAtualizada', () => {
  it('patches multiple fields without status guard (plan 0015)', () => {
    const original = criarContribuicao({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    const patched = contribuicaoAtualizada(original, {
      nome: 'Fralda Premium',
      valor: 9000,
    });
    expect(patched.nome).toBe('Fralda Premium');
    expect(patched.valor).toBe(9000);
    // unchanged fields preserved
    expect(patched.id).toBe(idContribuicao);
    expect(patched.criadaEm).toBe(criadaEm);
  });

  it('treats null in imagemUrl/grupo as "clear", undefined as "no change"', () => {
    const original = criarContribuicao({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      imagemUrl: 'https://cdn.example.com/old.png',
      grupo: 'vestuario',
      criadaEm,
    });
    const patched = contribuicaoAtualizada(original, {
      imagemUrl: null,
    });
    expect(patched.imagemUrl).toBeNull();
    expect(patched.grupo).toBe('vestuario'); // undefined → no change
  });

  it('preserves the slot when patch is empty', () => {
    const original = criarContribuicao({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao,
      nome: 'Fralda',
      valor: 5000,
      criadaEm,
    });
    const patched = contribuicaoAtualizada(original, {});
    expect(patched).toEqual(original);
  });
});
