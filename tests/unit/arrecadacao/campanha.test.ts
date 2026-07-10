import { describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/adapters/plataforma/repository.memory.js';
import {
  type Campanha,
  campanhaComAdministrador,
  campanhaComOpcao,
  campanhaComRecebedorAtivo,
  campanhaPossuiAdministrador,
  campanhaSemAdministrador,
  campanhaSemRecebedor,
  campanhaTemRecebedor,
  criarCampanhaSemRecebedor,
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
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
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
  idPlataforma: ID_PLATAFORMA_EUNENEM,
  idsAdministradores: [idAdministrador1] as const,
  idRecebedor,
  dadosRecebedor: dadosRecebedorEmail,
  titulo: 'Campanha',
  slug: null,
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
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('accepts valid input with multiple administrators', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1, idAdministrador2],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty administrators array', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate administrator ids', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1, idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty title', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
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
      metodo: 'pix' as const,
      nomeTitular: 'Joao Santos',
      cpfTitular: '52998224725',
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

describe('CriarCampanhaInputSchema — Recebedor opcional', () => {
  it('accepts input without dadosRecebedor (pre-bank-info lifecycle)', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      titulo: 'Lista de Casamento sem PIX cadastrado',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dadosRecebedor).toBeUndefined();
    }
  });

  it('still accepts input WITH dadosRecebedor (legacy / full create)', () => {
    const r = CriarCampanhaInputSchema.safeParse({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      dadosRecebedor: dadosRecebedorEmail,
      titulo: 'Ajuda ao Joao',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dadosRecebedor).toEqual(dadosRecebedorEmail);
    }
  });
});

describe('campanhaTemRecebedor', () => {
  it('returns true when both idRecebedor and dadosRecebedor are set', () => {
    expect(campanhaTemRecebedor(baseCampanha)).toBe(true);
  });

  it('returns false when both fields are null', () => {
    const semRecebedor: Campanha = {
      ...baseCampanha,
      idRecebedor: null,
      dadosRecebedor: null,
    };
    expect(campanhaTemRecebedor(semRecebedor)).toBe(false);
  });

  it('narrows the type predicate so dadosRecebedor is accessible without null check', () => {
    const c: Campanha = baseCampanha;
    if (campanhaTemRecebedor(c)) {
      // TypeScript narrowing — c.dadosRecebedor is non-null here.
      expect(c.dadosRecebedor.nomeTitular).toBe('Maria Silva');
    } else {
      throw new Error('expected baseCampanha to have a Recebedor');
    }
  });
});

describe('criarCampanhaSemRecebedor', () => {
  it('produces a Campanha with idRecebedor=null and dadosRecebedor=null', () => {
    const campanha = criarCampanhaSemRecebedor({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      titulo: 'Campanha sem PIX',
      opcoes: [],
      criadaEm: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(campanha.idRecebedor).toBeNull();
    expect(campanha.dadosRecebedor).toBeNull();
    expect(campanhaTemRecebedor(campanha)).toBe(false);
    expect(campanha.titulo).toBe('Campanha sem PIX');
  });

  it('preserves immutable identity (returns plain Campanha, no extra fields)', () => {
    const campanha = criarCampanhaSemRecebedor({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      titulo: 'Campanha',
      opcoes: [],
      criadaEm: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(Object.keys(campanha).sort()).toEqual(
      [
        'criadaEm',
        'dadosRecebedor',
        'id',
        'idPlataforma',
        'idRecebedor',
        'idsAdministradores',
        'opcoes',
        // aperture-aphk8: the campanha's own URL slug (defaults to null).
        'slug',
        'titulo',
      ].sort(),
    );
  });
});

describe('campanhaSemRecebedor', () => {
  it('clears Recebedor projection from a campanha that had one', () => {
    expect(campanhaTemRecebedor(baseCampanha)).toBe(true);
    const next = campanhaSemRecebedor(baseCampanha);
    expect(next.idRecebedor).toBeNull();
    expect(next.dadosRecebedor).toBeNull();
    expect(campanhaTemRecebedor(next)).toBe(false);
  });

  it('is idempotent when called on a campanha without Recebedor', () => {
    const semRecebedor = criarCampanhaSemRecebedor({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      titulo: 'Campanha',
      opcoes: [],
      criadaEm: new Date('2026-01-01T00:00:00.000Z'),
    });
    const next = campanhaSemRecebedor(semRecebedor);
    expect(next.idRecebedor).toBeNull();
    expect(next.dadosRecebedor).toBeNull();
  });

  it('preserves non-recebedor fields immutably', () => {
    const next = campanhaSemRecebedor(baseCampanha);
    expect(next.id).toBe(baseCampanha.id);
    expect(next.titulo).toBe(baseCampanha.titulo);
    expect(next.idPlataforma).toBe(baseCampanha.idPlataforma);
    expect(next.idsAdministradores).toEqual(baseCampanha.idsAdministradores);
    // Original is untouched (immutability check)
    expect(baseCampanha.idRecebedor).toBe(idRecebedor);
    expect(baseCampanha.dadosRecebedor).toEqual(dadosRecebedorEmail);
  });
});

describe('TOGETHER invariant — defense in depth', () => {
  // The invariant assertInvarianteRecebedor (private to the entity module)
  // is enforced by every projection helper. Under the current public API,
  // ALL helpers set idRecebedor + dadosRecebedor together (both null OR
  // both non-null), so the assertion cannot fire from normal call sites.
  // These tests lock in that invariant for future contributors: every
  // public projection helper must produce coherent state.

  it('campanhaComRecebedorAtivo always sets both fields from the recebedor', () => {
    const semRecebedor = criarCampanhaSemRecebedor({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [idAdministrador1],
      titulo: 'Campanha',
      opcoes: [],
      criadaEm: new Date('2026-01-01T00:00:00.000Z'),
    });
    const next = campanhaComRecebedorAtivo(semRecebedor, recebedorAtivo);
    expect(next.idRecebedor).toBe(idRecebedor);
    expect(next.dadosRecebedor).toEqual(dadosRecebedorEmail);
    expect(campanhaTemRecebedor(next)).toBe(true);
  });

  // NOTE: the assertInvarianteRecebedor helper inside the entity module
  // is unreachable from the current public API (every projection helper
  // sets idRecebedor + dadosRecebedor together from a coherent source).
  // The assertion remains as defense-in-depth for any future helper that
  // mutates one field without the other. No direct unit test exists
  // because the path can't be exercised without exposing the private
  // helper or casting to an invalid Campanha shape — both worse than
  // leaving the assertion as a structural guard. The 3 tests above
  // lock the COHERENT-state property of every public projection helper.
});
