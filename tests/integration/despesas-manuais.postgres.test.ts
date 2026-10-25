import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-0ngn4 — despesas recorrentes/manuais contra Postgres real, pelo
 * router.
 *
 * Despesa manual = valor CONHECIDO (servidor, ferramenta, assinatura):
 * sempre confirmada. Mensal cai no dia de cobrança (1–28) de cada mês, de
 * `inicio` até `fim`; única cai na própria data. Mudar o valor cria uma
 * vigência nova (`vigenteDesde`) e não reescreve meses anteriores.
 * Ocorrência só conta depois que acontece (dia ≤ hoje em SP).
 *
 * Calendário igual ao da aba Despesas: hoje = segunda 05/10/2037 12:00 SP.
 *   30/09 ⇒ setembro;  01/10 ⇒ outubro, semana 28/09–04/10;
 *   04/10 (domingo) ⇒ semana anterior;  05/10 ⇒ semana corrente 05–11/10.
 */

const NOW = new Date('2037-10-05T15:00:00.000Z');

let testDb: TestDatabase;

async function limpar() {
  await sql`DELETE FROM despesas_manuais_valores`.execute(testDb.db);
  await sql`DELETE FROM despesas_manuais`.execute(testDb.db);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await limpar();
  await testDb.teardown();
});

beforeEach(limpar);

function caller(opts: { sessao?: boolean; allowlist?: string[] } = {}) {
  const auth = adminAuthOverrides();
  const deps = {
    ...auth.depsOverrides,
    ...(opts.allowlist ? { adminAllowedEmails: new Set(opts.allowlist) } : {}),
    db: testDb.db,
    clock: () => NOW,
    logPiiHashSalt: 'despesas-manuais-integration-salt',
    interFeeAccountRef: 'acct_fixture',
  } as unknown as ServerDeps;
  const ctx: TrpcContext = {
    deps,
    headers: opts.sessao === false ? new Headers() : auth.headers,
    resHeaders: new Headers(),
  };
  return appRouter.createCaller(ctx);
}

const admin = () => caller().admin.despesas.manuais;

async function mensal(
  nome: string,
  valorCents: number,
  diaCobranca: number,
  inicio: string,
  fim?: string,
) {
  return admin().criar({
    nome,
    valorCents,
    tipo: { recorrencia: 'mensal', diaCobranca, inicio, ...(fim ? { fim } : {}) },
  });
}

async function unica(nome: string, valorCents: number, data: string) {
  return admin().criar({ nome, valorCents, tipo: { recorrencia: 'unica', data } });
}

async function painel() {
  return caller().admin.despesas.painel();
}

function mes(p: Awaited<ReturnType<typeof painel>>, de: string) {
  const m = p.meses.find((x) => x.de === de);
  if (!m) throw new Error(`sem mês ${de}`);
  return m;
}

describe('Despesas manuais — ocorrência mensal no dia de cobrança (SP)', () => {
  it('cai uma vez por mês a partir do início, só até hoje, e entra no total como confirmada', async () => {
    await mensal('Servidor', 10_000, 4, '2037-08-01');
    const p = await painel();

    expect(mes(p, '2037-07-01').manualCents).toBe(0);
    expect(mes(p, '2037-08-01').manualCents).toBe(10_000);
    expect(mes(p, '2037-09-01').manualCents).toBe(10_000);
    // 04/10 (domingo) já aconteceu: outubro e semana anterior.
    expect(mes(p, '2037-10-01').manualCents).toBe(10_000);
    expect(p.kpis.mesAtual.manualCents).toBe(10_000);
    expect(p.kpis.semanaAnterior.manualCents).toBe(10_000);
    expect(p.kpis.semanaAtual.manualCents).toBe(0);

    // totalCents (consumido pelo lucro líquido) inclui a série manual.
    expect(p.kpis.mesAtual.totalCents).toBe(
      p.kpis.mesAtual.stripeCents + p.kpis.mesAtual.interCents + 10_000,
    );
    expect(p.kpis.mesAtual.cobertura.manual).toEqual({ confirmados: 1, pendentes: 0, falhos: 0 });
    expect(mes(p, '2037-09-01').cobertura.manual.confirmados).toBe(1);
  });

  it('cobrança ainda não ocorrida no mês corrente não conta (20/10 > hoje)', async () => {
    await mensal('Ferramenta', 5_000, 20, '2037-09-01');
    const p = await painel();
    expect(mes(p, '2037-09-01').manualCents).toBe(5_000);
    expect(p.kpis.mesAtual.manualCents).toBe(0);
    expect(p.kpis.mesAtual.cobertura.manual.confirmados).toBe(0);
  });

  it('início no meio do mês: o mês só tem cobrança se o dia de cobrança ≥ início', async () => {
    await mensal('Assinatura', 2_000, 10, '2037-08-15');
    const p = await painel();
    expect(mes(p, '2037-08-01').manualCents).toBe(0);
    expect(mes(p, '2037-09-01').manualCents).toBe(2_000);
  });
});

describe('Despesas manuais — bordas de mês e semana em São Paulo', () => {
  it('única: 30/09 é setembro, 01/10 é outubro e semana anterior; 05/10 é semana corrente', async () => {
    await unica('Domínio', 1_100, '2037-09-30');
    await unica('Certificado', 2_200, '2037-10-01');
    await unica('Licença', 3_300, '2037-10-05');
    await unica('Futura', 9_900, '2037-10-06');
    const p = await painel();

    expect(mes(p, '2037-09-01').manualCents).toBe(1_100);
    expect(mes(p, '2037-10-01').manualCents).toBe(5_500);
    expect(p.kpis.mesAnterior.manualCents).toBe(1_100);
    expect(p.kpis.semanaAnterior.manualCents).toBe(1_100 + 2_200);
    expect(p.kpis.semanaAtual.manualCents).toBe(3_300);
    const semana = p.semanas.find((s) => s.estado === 'atual');
    expect(semana?.manualCents).toBe(3_300);
    expect(semana?.totalCents).toBe(3_300);
  });
});

describe('Despesas manuais — fim e vigência', () => {
  it('fim interrompe as ocorrências seguintes; encerrar não apaga as anteriores', async () => {
    const { id } = await mensal('Antigo', 4_000, 10, '2037-06-01', '2037-08-31');
    await mensal('Encerrável', 1_000, 3, '2037-08-01');
    let p = await painel();
    expect(mes(p, '2037-06-01').manualCents).toBe(4_000);
    expect(mes(p, '2037-08-01').manualCents).toBe(4_000 + 1_000);
    expect(mes(p, '2037-09-01').manualCents).toBe(1_000);
    expect(id).toBeTypeOf('string');

    const lista = await admin().listar();
    const encerravel = lista.despesas.find((d) => d.nome === 'Encerrável');
    if (!encerravel) throw new Error('sem Encerrável');
    await admin().encerrar({ id: encerravel.id, fim: '2037-09-15' });

    p = await painel();
    expect(mes(p, '2037-08-01').manualCents).toBe(5_000);
    expect(mes(p, '2037-09-01').manualCents).toBe(1_000);
    expect(mes(p, '2037-10-01').manualCents).toBe(0);

    await expect(admin().encerrar({ id: encerravel.id, fim: '2037-09-20' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('mudar o valor vale a partir da data de vigência e não reescreve meses anteriores', async () => {
    const { id } = await mensal('Servidor', 10_000, 15, '2037-07-01');
    // Vigência depois do dia 15 de setembro: setembro ainda é o valor antigo.
    await admin().alterarValor({ id, valorCents: 15_000, vigenteDesde: '2037-09-16' });
    const p = await painel();
    expect(mes(p, '2037-07-01').manualCents).toBe(10_000);
    expect(mes(p, '2037-08-01').manualCents).toBe(10_000);
    expect(mes(p, '2037-09-01').manualCents).toBe(10_000);
    // Outubro: dia 15 ainda não chegou.
    expect(mes(p, '2037-10-01').manualCents).toBe(0);

    await admin().alterarValor({ id, valorCents: 12_000, vigenteDesde: '2037-10-20' });
    const lista = await admin().listar();
    const d = lista.despesas.find((x) => x.id === id);
    expect(d?.valores).toEqual([
      { vigenteDesde: '2037-07-01', valorCents: 10_000 },
      { vigenteDesde: '2037-09-16', valorCents: 15_000 },
      { vigenteDesde: '2037-10-20', valorCents: 12_000 },
    ]);
    expect(d?.valorAtualCents).toBe(15_000);
  });

  it('vigência que vale antes do mês já cobrado altera só dali em diante', async () => {
    const { id } = await mensal('Servidor', 10_000, 1, '2037-07-01');
    await admin().alterarValor({ id, valorCents: 20_000, vigenteDesde: '2037-09-01' });
    const p = await painel();
    expect(mes(p, '2037-08-01').manualCents).toBe(10_000);
    expect(mes(p, '2037-09-01').manualCents).toBe(20_000);
    expect(mes(p, '2037-10-01').manualCents).toBe(20_000);
  });

  it('rejeita vigência que não seja posterior à última, e mudança em despesa única', async () => {
    const { id } = await mensal('Servidor', 10_000, 1, '2037-07-01');
    await admin().alterarValor({ id, valorCents: 20_000, vigenteDesde: '2037-09-01' });
    await expect(
      admin().alterarValor({ id, valorCents: 30_000, vigenteDesde: '2037-09-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      admin().alterarValor({ id, valorCents: 30_000, vigenteDesde: '2037-08-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const u = await unica('Domínio', 1_000, '2037-09-30');
    await expect(
      admin().alterarValor({ id: u.id, valorCents: 2_000, vigenteDesde: '2037-10-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(admin().encerrar({ id: u.id, fim: '2037-10-01' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('valida entrada: dia 1–28, valor positivo, fim ≥ início, id inexistente', async () => {
    await expect(mensal('X', 1_000, 29, '2037-07-01')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(mensal('X', 0, 5, '2037-07-01')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(mensal('X', 1_000, 5, '2037-07-01', '2037-06-30')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(mensal('  ', 1_000, 5, '2037-07-01')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      admin().encerrar({ id: '00000000-0000-4000-8000-000000000000', fim: '2037-10-01' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('listar devolve tipo, categoria, datas e o valor vigente hoje', async () => {
    await admin().criar({
      nome: 'Servidor',
      categoria: 'Infra',
      valorCents: 10_000,
      tipo: { recorrencia: 'mensal', diaCobranca: 5, inicio: '2037-01-01' },
    });
    await unica('Domínio', 1_100, '2037-09-30');
    const { despesas } = await admin().listar();
    expect(despesas).toHaveLength(2);
    expect(despesas.find((d) => d.nome === 'Servidor')).toMatchObject({
      categoria: 'Infra',
      recorrencia: 'mensal',
      diaCobranca: 5,
      inicio: '2037-01-01',
      fim: null,
      data: null,
      valorAtualCents: 10_000,
    });
    expect(despesas.find((d) => d.nome === 'Domínio')).toMatchObject({
      categoria: null,
      recorrencia: 'unica',
      diaCobranca: null,
      inicio: null,
      data: '2037-09-30',
      valorAtualCents: 1_100,
    });
  });
});

describe('Despesas manuais — lucro líquido (aperture-imtk7) subtrai as manuais', () => {
  it('lucro do período = resultado das tarifas − total de Despesas, com as manuais dentro', async () => {
    await mensal('Servidor', 10_000, 4, '2037-08-01');
    await unica('Licença', 3_300, '2037-10-05');
    const receita = await caller().admin.receita.painel();
    const despesas = await painel();
    const setembro = receita.lucro.meses.find((m) => m.de === '2037-09-01');
    const receitaSetembro = receita.meses.find((m) => m.de === '2037-09-01');
    expect(setembro?.estado).toBe('completo');
    expect(setembro?.valorCents).toBe(
      (receitaSetembro?.tarifas.resultadoCents ?? Number.NaN) -
        mes(despesas, '2037-09-01').totalCents,
    );
    expect(mes(despesas, '2037-09-01').totalCents).toBe(10_000);
    const semana = receita.lucro.semanas.find((s) => s.de === '2037-10-05');
    expect(semana?.valorCents).toBe(-3_300);
  });
});

describe('Despesas manuais — acesso', () => {
  it('bloqueia sem sessão (UNAUTHORIZED) e fora da allowlist (FORBIDDEN), em leitura e escrita', async () => {
    const entrada = {
      nome: 'X',
      valorCents: 1_000,
      tipo: { recorrencia: 'unica' as const, data: '2037-10-01' },
    };
    await expect(caller({ sessao: false }).admin.despesas.manuais.listar()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({ sessao: false }).admin.despesas.manuais.criar(entrada),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const fora = caller({ allowlist: ['outra-pessoa@example.com'] }).admin.despesas.manuais;
    await expect(fora.listar()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fora.criar(entrada)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      fora.alterarValor({
        id: '00000000-0000-4000-8000-000000000000',
        valorCents: 1,
        vigenteDesde: '2037-10-01',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      fora.encerrar({ id: '00000000-0000-4000-8000-000000000000', fim: '2037-10-01' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const n = await sql<{ n: string }>`SELECT COUNT(*) AS n FROM despesas_manuais`.execute(
      testDb.db,
    );
    expect(Number(n.rows[0]?.n)).toBe(0);
  });
});
