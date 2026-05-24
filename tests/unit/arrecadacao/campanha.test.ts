import { describe, expect, it } from 'vitest';
import {
  campanhaComAdministrador,
  campanhaComOpcao,
  campanhaComRecebedorAtivo,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
  encontrarOpcaoContribuicao,
} from '../../../src/domain/arrecadacao/entities/campanha.js';
import { criarRecebedorInicial } from '../../../src/domain/arrecadacao/entities/recebedor.js';
import { DadosRecebedorSchema } from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { AlterarDadosRecebedorCampanhaInputSchema } from '../../../src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.js';
import { CriarCampanhaInputSchema } from '../../../src/use-cases/arrecadacao/criar-campanha.js';

const idCampanha = '550e8400-e29b-41d4-a716-446655440001';
const idAdministrador1 = '550e8400-e29b-41d4-a716-446655440002';
const idAdministrador2 = '550e8400-e29b-41d4-a716-446655440005';
const idRecebedor = '550e8400-e29b-41d4-a716-446655440006';
const idOpcao = '550e8400-e29b-41d4-a716-446655440004';

const dadosRecebedorEmail = {
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
};

const recebedorAtivo = criarRecebedorInicial({
  id: idRecebedor,
  idCampanha,
  dadosRecebedor: dadosRecebedorEmail,
  criadaEm: new Date('2026-01-01T00:00:00.000Z'),
});

const baseCampanha = {
  id: idCampanha,
  idsAdministradores: [idAdministrador1] as const,
  idRecebedor,
  dadosRecebedor: dadosRecebedorEmail,
  titulo: 'Campanha',
  opcoes: [] as const,
  criadaEm: new Date('2026-01-01T00:00:00.000Z'),
};

describe('DadosRecebedorSchema', () => {
  it('accepts valid email key', () => {
    const r = DadosRecebedorSchema.safeParse(dadosRecebedorEmail);
    expect(r.success).toBe(true);
  });

  it('rejects empty nomeTitular', () => {
    const r = DadosRecebedorSchema.safeParse({
      ...dadosRecebedorEmail,
      nomeTitular: '   ',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty chavePix', () => {
    const r = DadosRecebedorSchema.safeParse({
      ...dadosRecebedorEmail,
      chavePix: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid email when tipoChavePix is email', () => {
    const r = DadosRecebedorSchema.safeParse({
      ...dadosRecebedorEmail,
      chavePix: 'nao-e-email',
    });
    expect(r.success).toBe(false);
  });
});

describe('CriarCampanhaInputSchema', () => {
  it('accepts valid input with one administrator', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('accepts valid input with multiple administrators', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1, idAdministrador2],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty administrators array', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate administrator ids', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1, idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty title', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idsAdministradores: [idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
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
    const opcao = { id: idOpcao, tipo: 'presente' as const };
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
    const opcao = { id: idOpcao, tipo: 'rifa' as const };
    const next = campanhaComOpcao(baseCampanha, opcao);
    expect(baseCampanha.opcoes).toHaveLength(0);
    expect(next.opcoes).toHaveLength(1);
    expect(next.opcoes[0]).toEqual(opcao);
  });
});

describe('campanhaComRecebedorAtivo', () => {
  it('projects active receiver from new receiver row', () => {
    const novosDados = {
      nomeTitular: 'Joao Santos',
      tipoChavePix: 'cpf' as const,
      chavePix: '12345678901',
    };
    const novoRecebedor = {
      ...recebedorAtivo,
      id: '550e8400-e29b-41d4-a716-446655440099',
      dadosRecebedor: novosDados,
    };
    const next = campanhaComRecebedorAtivo(baseCampanha, novoRecebedor);
    expect(baseCampanha.dadosRecebedor).toEqual(dadosRecebedorEmail);
    expect(next.dadosRecebedor).toEqual(novosDados);
    expect(next.id).toBe(idCampanha);
    expect(next.idRecebedor).toBe(novoRecebedor.id);
  });
});

describe('AlterarDadosRecebedorCampanhaInputSchema', () => {
  it('accepts valid input', () => {
    const r = AlterarDadosRecebedorCampanhaInputSchema.safeParse({
      idCampanha,
      dadosRecebedor: dadosRecebedorEmail,
    });
    expect(r.success).toBe(true);
  });
});
