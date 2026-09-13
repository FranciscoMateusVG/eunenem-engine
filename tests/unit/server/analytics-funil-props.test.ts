/**
 * aperture-ai8vg — pure prop builders for the creator-funnel server events +
 * the versioned legacy classification + the guarded signup_at read.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classificarLegado,
  type LegacyUserEntry,
  snapshotLegado,
} from '../../../apps/eunenem-server/lib/legacy-users.js';
import {
  fatoPerfilSalvo,
  lerSignupAt,
  maisAntigo,
  propsCampanhaCriada,
  propsContaCriada,
  propsConvidadoCriado,
  propsConviteCriado,
  propsListaItemCriado,
  propsPerfilCampanhaSalvo,
} from '../../../apps/eunenem-server/server/analytics/funil.js';

const SIGNUP = new Date('2026-09-13T12:00:00.000Z');

describe('classificarLegado (versioned snapshot, never a historical certainty)', () => {
  const entries: LegacyUserEntry[] = [
    { email: 'Ana@Example.com', nome: 'Lista da Ana', utm: null, mimos: 0 } as LegacyUserEntry,
  ];

  it('is true/false against the given snapshot and names the snapshot', () => {
    const snap = snapshotLegado(entries);
    expect(classificarLegado('ana@example.com', entries)).toEqual({
      migrado_1_0: true,
      legado_snapshot: snap,
    });
    expect(classificarLegado('bia@example.com', entries)).toEqual({
      migrado_1_0: false,
      legado_snapshot: snap,
    });
    expect(snap).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is 'unknown' when undecidable: blank email or an empty snapshot", () => {
    expect(classificarLegado('   ', entries).migrado_1_0).toBe('unknown');
    expect(classificarLegado('ana@example.com', []).migrado_1_0).toBe('unknown');
  });

  it('snapshot hash depends only on the normalized email set', () => {
    const reordered: LegacyUserEntry[] = [
      { email: 'b@x.com', nome: null, utm: null, mimos: 0 } as LegacyUserEntry,
      { email: 'A@X.com', nome: null, utm: null, mimos: 0 } as LegacyUserEntry,
    ];
    const canonical: LegacyUserEntry[] = [
      { email: 'a@x.com', nome: 'qualquer', utm: null, mimos: 3 } as LegacyUserEntry,
      { email: 'B@x.com', nome: null, utm: null, mimos: 0 } as LegacyUserEntry,
    ];
    expect(snapshotLegado(reordered)).toBe(snapshotLegado(canonical));
  });
});

describe('propsContaCriada', () => {
  it('separates signup occurrence from lazy emission and never infers metodo', () => {
    const props = propsContaCriada({
      idPlataforma: 'plat',
      legado: { migrado_1_0: false, legado_snapshot: 'abc' },
      signupAt: SIGNUP,
      idCampanhaPadrao: 'camp-1',
    });
    expect(props).toEqual({
      idPlataforma: 'plat',
      migrado_1_0: false,
      legado_snapshot: 'abc',
      id_campanha_padrao: 'camp-1',
      signup_at: SIGNUP.toISOString(),
    });
    expect(props).not.toHaveProperty('metodo');
    expect(props).not.toHaveProperty('email');
  });

  it('omits what it does not know', () => {
    const props = propsContaCriada({
      idPlataforma: 'plat',
      legado: { migrado_1_0: 'unknown', legado_snapshot: 'abc' },
    });
    expect(props).toEqual({ idPlataforma: 'plat', migrado_1_0: 'unknown', legado_snapshot: 'abc' });
  });
});

describe('propsCampanhaCriada', () => {
  it('is explicit-only and carries no title', () => {
    expect(propsCampanhaCriada('camp-1')).toEqual({ idCampanha: 'camp-1', origem: 'explicita' });
  });
});

describe('propsListaItemCriado', () => {
  it('counts lines and units per write; makes NO first-item claim', () => {
    const props = propsListaItemCriado({
      idCampanha: 'c',
      items: [{ quantidade: 3 }, { quantidade: undefined }],
    });
    expect(props).toEqual({ id_campanha: 'c', linhas: 2, quantidade_itens: 4 });
    expect(props).not.toHaveProperty('primeiro_item');
  });
});

describe('maisAntigo (persisted criadaEm of the rows a write created)', () => {
  const t0 = new Date('2026-09-13T12:00:00.000Z');
  const t1 = new Date('2026-09-13T12:00:01.000Z');

  it('is the earliest criadaEm; ties break on id (deterministic)', () => {
    const a = { id: 'b-id', criadaEm: t0 };
    const b = { id: 'a-id', criadaEm: t0 };
    const c = { id: 'c-id', criadaEm: t1 };
    expect(maisAntigo([c, a, b])).toBe(b);
    expect(maisAntigo([b, c, a])).toBe(b);
    expect(maisAntigo([c])).toBe(c);
    expect(maisAntigo([])).toBeUndefined();
  });
});

describe('propsPerfilCampanhaSalvo', () => {
  it('reports named + a field COUNT, never the values, and NO first-save claim', () => {
    const props = propsPerfilCampanhaSalvo({
      idCampanha: 'c',
      conteudo: {
        nomeBebe: ' Maria ',
        historia: '',
        relacao: null,
        dataEvento: new Date(),
        genero: 'f',
      },
    });
    expect(props).toEqual({ id_campanha: 'c', nomeado: true, campos_preenchidos: 3 });
    expect(props).not.toHaveProperty('primeira_vez');
    expect(JSON.stringify(props)).not.toContain('Maria');
  });

  it('nomeado is false for a blank name', () => {
    expect(
      propsPerfilCampanhaSalvo({ idCampanha: 'c', conteudo: { nomeBebe: '   ' } }),
    ).toMatchObject({ nomeado: false, campos_preenchidos: 0 });
  });
});

describe('fatoPerfilSalvo (durable row after upsert)', () => {
  const criadoEm = new Date('2026-09-13T12:00:00.000Z');
  const atualizadoEm = new Date('2026-09-13T12:05:00.000Z');

  it('keys and times the event from the RE-READ row, never from a transient id', async () => {
    const repo = {
      findByIdCampanha: async () => ({ id: 'perfil-vencedor', criadoEm, atualizadoEm }),
    };
    await expect(fatoPerfilSalvo(repo as never, 'c')).resolves.toEqual({
      insertKey: `perfil-vencedor:${atualizadoEm.toISOString()}`,
      occurredAt: atualizadoEm,
    });
  });

  it('is undefined (event skipped) when the row is missing or the read fails', async () => {
    await expect(
      fatoPerfilSalvo({ findByIdCampanha: async () => undefined } as never, 'c'),
    ).resolves.toBeUndefined();
    await expect(
      fatoPerfilSalvo(
        {
          findByIdCampanha: async () => {
            throw new Error('db');
          },
        } as never,
        'c',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('propsConviteCriado / propsConvidadoCriado', () => {
  it('carry opaque ids and counts only', () => {
    expect(propsConviteCriado({ idCampanha: 'c', idEvento: 'e', modelo: 'classico' })).toEqual({
      id_campanha: 'c',
      id_evento: 'e',
      modelo: 'classico',
    });
    expect(propsConvidadoCriado({ idCampanha: 'c', idLista: 'l', totalConvidados: 4 })).toEqual({
      id_campanha: 'c',
      id_lista: 'l',
      total_convidados: 4,
    });
  });
});

describe('lerSignupAt', () => {
  function dbReturning(row: unknown, throwing = false) {
    const executeTakeFirst = vi.fn(async () => {
      if (throwing) throw new Error('db down');
      return row;
    });
    const chain = { select: () => chain, where: () => chain, executeTakeFirst };
    return { selectFrom: () => chain } as never;
  }

  it('returns users.created_at as a Date', async () => {
    await expect(lerSignupAt(dbReturning({ created_at: SIGNUP }), 'u1')).resolves.toBe(SIGNUP);
  });

  it('is undefined (prop omitted) on a missing row, a non-Date value, or a failure', async () => {
    await expect(lerSignupAt(dbReturning(undefined), 'u1')).resolves.toBeUndefined();
    await expect(lerSignupAt(dbReturning({ created_at: '2026' }), 'u1')).resolves.toBeUndefined();
    await expect(lerSignupAt(dbReturning(undefined, true), 'u1')).resolves.toBeUndefined();
  });
});
