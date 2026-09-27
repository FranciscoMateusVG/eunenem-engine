import { describe, expect, it } from 'vitest';
import {
  type FatoLancamentoAdmin,
  InvalidAdminUserLancamentosCursorError,
  paginateLancamentosAdmin,
} from '../../../apps/eunenem-server/server/admin-user-financeiro.js';

/**
 * aperture-5jk8y — keyset determinístico em TS sobre o conjunto classificado.
 * Ordem canônica: criado_em DESC, id ASC. totalCount nunca vem da página.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');
const T1 = new Date('2026-09-25T10:00:00.000Z');
const T2 = new Date('2026-09-24T10:00:00.000Z');
const SECRET = 'test-cursor-secret';
const CONTA_A = '11000000-0000-4000-8000-00000000000a';
const CONTA_B = '11000000-0000-4000-8000-00000000000b';
const CAMP_1 = '10000000-0000-4000-8000-000000000001';
const CAMP_2 = '10000000-0000-4000-8000-000000000002';

function fato(
  id: string,
  criadoEm: Date,
  overrides: Partial<FatoLancamentoAdmin> = {},
): FatoLancamentoAdmin {
  return {
    idLancamento: id,
    amountCents: 1000,
    criadoEm,
    pagamentoCriadoEm: criadoEm,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
    repasseStatus: null,
    pagamentoStatus: 'aprovado',
    availableOn: T2,
    estornoAtivo: false,
    disponivelCanonico: true,
    idCampanha: CAMP_1,
    campanhaTitulo: 'Chá 1',
    idContribuicao: '30000000-0000-4000-8000-000000000001',
    contribuicaoNome: 'Berço',
    idPagamento: '20000000-0000-4000-8000-000000000001',
    metodo: 'pix',
    ...overrides,
  };
}

// ids escolhidos para que a ordem lexicográfica seja explícita nos empates
const ID_A = '40000000-0000-4000-8000-00000000000a';
const ID_B = '40000000-0000-4000-8000-00000000000b';
const ID_C = '40000000-0000-4000-8000-00000000000c';
const ID_D = '40000000-0000-4000-8000-00000000000d';

const FATOS: FatoLancamentoAdmin[] = [
  fato(ID_C, T1), // empate em T1 com ID_A e ID_B — ordem por id ASC: A, B, C
  fato(ID_A, T1),
  fato(ID_B, T1, { canceladoEm: T1, disponivelCanonico: false }), // estornado
  fato(ID_D, T2, { idCampanha: CAMP_2, campanhaTitulo: 'Chá 2' }),
];

function page(input: Partial<Parameters<typeof paginateLancamentosAdmin>[0]> = {}) {
  return paginateLancamentosAdmin({
    fatos: FATOS,
    now: NOW,
    idConta: CONTA_A,
    estado: null,
    idCampanha: null,
    cursor: null,
    limit: 2,
    cursorSecret: SECRET,
    ...input,
  });
}

describe('paginateLancamentosAdmin', () => {
  it('ordena criado_em DESC com desempate id ASC e pagina de forma estável', () => {
    const p1 = page();
    expect(p1.rows.map((r) => r.fato.idLancamento)).toEqual([ID_A, ID_B]);
    expect(p1.totalCount).toBe(4);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = page({ cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.fato.idLancamento)).toEqual([ID_C, ID_D]);
    expect(p2.totalCount).toBe(4);
    expect(p2.nextCursor).toBeNull();
  });

  it('limit maior que o conjunto → tudo em uma página, sem cursor', () => {
    const p = page({ limit: 50 });
    expect(p.rows).toHaveLength(4);
    expect(p.nextCursor).toBeNull();
  });

  it('filtro por bucket muda totalCount (nunca da página) e mantém a ordem', () => {
    const p = page({ estado: 'disponivel', limit: 1 });
    expect(p.totalCount).toBe(3);
    expect(p.rows.map((r) => r.fato.idLancamento)).toEqual([ID_A]);
    const p2 = page({ estado: 'disponivel', limit: 1, cursor: p.nextCursor });
    expect(p2.rows.map((r) => r.fato.idLancamento)).toEqual([ID_C]);
    const est = page({ estado: 'estornado' });
    expect(est.totalCount).toBe(1);
    expect(est.rows[0]?.classificacao.bucket).toBe('estornado');
  });

  it('filtro por campanha', () => {
    const p = page({ idCampanha: CAMP_2 });
    expect(p.rows.map((r) => r.fato.idLancamento)).toEqual([ID_D]);
    expect(p.totalCount).toBe(1);
  });

  it('cursor de outra conta é rejeitado (digest inclui idConta)', () => {
    const p1 = page();
    expect(() => page({ idConta: CONTA_B, cursor: p1.nextCursor })).toThrow(
      InvalidAdminUserLancamentosCursorError,
    );
  });

  it('cursor com filtros diferentes é rejeitado', () => {
    const p1 = page();
    expect(() => page({ estado: 'disponivel', cursor: p1.nextCursor })).toThrow(
      InvalidAdminUserLancamentosCursorError,
    );
    expect(() => page({ idCampanha: CAMP_1, cursor: p1.nextCursor })).toThrow(
      InvalidAdminUserLancamentosCursorError,
    );
  });

  it.each([
    '',
    'not-base64!',
    Buffer.from('{"version":1}').toString('base64url'),
    'x'.repeat(1025),
  ])('cursor malformado %j → erro tipado', (cursor) => {
    expect(() => page({ cursor })).toThrow(InvalidAdminUserLancamentosCursorError);
  });

  it('lançamento duplicado por id conta uma vez', () => {
    const p = page({
      fatos: [FATOS[1] as FatoLancamentoAdmin, FATOS[1] as FatoLancamentoAdmin],
      limit: 10,
    });
    expect(p.rows).toHaveLength(1);
    expect(p.totalCount).toBe(1);
  });

  it('conjunto vazio', () => {
    const p = page({ fatos: [] });
    expect(p.rows).toEqual([]);
    expect(p.totalCount).toBe(0);
    expect(p.nextCursor).toBeNull();
  });
});
