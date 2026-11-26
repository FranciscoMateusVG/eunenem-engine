import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { carregarCertificado } from '../../apps/eunenem-server/server/nfse/assinatura.js';
import {
  CertificadoNfse,
  type NfseEnv,
  parseNfseConfig,
} from '../../apps/eunenem-server/server/nfse/config.js';
import {
  type FabricaClienteSefin,
  gravarNotas,
} from '../../apps/eunenem-server/server/nfse/emissao.js';
import { criarClienteSefin } from '../../apps/eunenem-server/server/nfse/sefin-cliente.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { type FakeSefin, iniciarFakeSefin } from '../helpers/fake-sefin.js';
import { gerarPfxDeTeste, type TestPfx } from '../helpers/nfse-test-pfx.js';
import { validateDpsDoLeiaute } from '../helpers/nfse-xsd.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import {
  verificarAssinaturaDps,
  verificarAssinaturaPedidoEvento,
} from '../helpers/xmldsig-verify.js';

/**
 * aperture-wp6j6 — emissão REAL da NFS-e mensal: router admin + Postgres real
 * + fake HTTPS do Sefin com mTLS. Nenhum endpoint da Receita é chamado.
 *
 * Datas em 2033 (o container é compartilhado com a prévia, que usa 2032).
 */

const CNPJ = '11222333000181';
const IBGE = '3106200';
const MES = '2033-03';
const NOW = new Date('2033-04-10T15:00:00.000Z');
const CPF_A = '52998224725';
const CPF_B = '11144477735';
const CPF_C = '39053344705';

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed & {
  recebedor(campanha: string, cpf: string | null, nome: string): Promise<void>;
};
let pfx: TestPfx;
let fake: FakeSefin;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const db = testDb.db;
  seed = new (class extends ReceitaLedgerSeed {
    ids: string[] = [];
    override async campanha(platformId = ID_PLATAFORMA_EUNENEM) {
      const id = await super.campanha(platformId);
      this.ids.push(id);
      return id;
    }
    async recebedor(campanha: string, cpf: string | null, nome: string) {
      await sql`INSERT INTO recebedores(id,campanha_id,metodo,nome_titular,cpf_titular,tipo_chave_pix,chave_pix,is_active,criada_em)
        VALUES(${randomUUID()}::uuid,${campanha}::uuid,'pix',${nome},${cpf},'cpf',${cpf ?? 'x'},true,'2031-01-01T15:00:00Z')`.execute(
        db,
      );
    }
    override async wipe() {
      if (this.ids.length)
        await sql`DELETE FROM recebedores WHERE campanha_id IN (${sql.join(this.ids)})`.execute(db);
      this.ids = [];
      await super.wipe();
    }
  })(db);
  // Válido "agora" de verdade (o TLS do fake confere) e em 2033 (a prévia confere contra NOW).
  pfx = gerarPfxDeTeste({
    cnpj: CNPJ,
    validoDe: new Date(Date.now() - 86_400_000),
    validoAte: new Date('2040-01-01T00:00:00Z'),
  });
  const material = carregarCertificado(new CertificadoNfse('base64', () => pfx.pfx, pfx.senha));
  fake = await iniciarFakeSefin({ clienteCertPem: material.certificatePem });
}, 60_000);

beforeEach(async () => {
  await sql`DELETE FROM nfse_emissoes`.execute(testDb.db);
  await sql`DELETE FROM nfse_numeracao`.execute(testDb.db);
  await seed.wipe();
  fake.requisicoes.length = 0;
  fake.notas.clear();
  fake.proximaEmissao = [];
  fake.reacaoEvento = 'registrar';
  fake.reacaoConsultaDps = 'normal';
});

afterAll(async () => {
  await seed.wipe();
  await fake.fechar();
  await testDb.teardown();
});

const ENV_COMPLETO: NfseEnv = {
  NFSE_PRESTADOR_CNPJ: CNPJ,
  NFSE_MUNICIPIO_IBGE: IBGE,
  NFSE_CERT_BASE64: '',
  NFSE_CERT_PASSWORD: '',
  // Leiaute de produção nos testes gerais (o RTC exige NBS/endereço).
  NFSE_LEIAUTE_DPS: 'producao-2026-02',
};

function env(extra: NfseEnv = {}): NfseEnv {
  return {
    ...ENV_COMPLETO,
    NFSE_CERT_BASE64: pfx.pfx.toString('base64'),
    NFSE_CERT_PASSWORD: pfx.senha,
    ...extra,
  };
}

/** Fábrica de cliente apontando para o fake (o único desvio da produção). */
const fabricaFake: FabricaClienteSefin = ({ material }) =>
  criarClienteSefin({
    hosts: { sefin: `${fake.baseUrl}/SefinNacional`, adn: fake.baseUrl },
    material,
    caPem: fake.caPem,
    timeoutMs: 2_000,
  });

function caller(opts: { env?: NfseEnv; now?: Date } = {}) {
  const auth = adminAuthOverrides();
  const deps = {
    ...auth.depsOverrides,
    db: testDb.db,
    clock: () => opts.now ?? NOW,
    logPiiHashSalt: 'nfse-emissao-integration-salt',
    nfse: parseNfseConfig(opts.env ?? env()),
    nfseClienteSefin: fabricaFake,
  } as unknown as ServerDeps;
  const ctx: TrpcContext = { deps, headers: auth.headers, resHeaders: new Headers() };
  return appRouter.createCaller(ctx).admin.notaFiscal;
}

/**
 * Proxy do Kysely para testes de corrida: antes do `execute` da N-ésima
 * leitura `selectFrom(tabela)`, roda `gancho` (ex.: outro clique gravando).
 */
function comGanchoNaLeitura<T extends object>(
  db: T,
  tabela: string,
  n: number,
  gancho: () => Promise<void>,
): T {
  let leituras = 0;
  const envolver = (alvo: object, disparar: boolean): object =>
    new Proxy(alvo, {
      get(obj, prop, recv) {
        const v = Reflect.get(obj, prop, recv);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (
            prop === 'execute' ||
            prop === 'executeTakeFirst' ||
            prop === 'executeTakeFirstOrThrow'
          ) {
            return (async () => {
              if (disparar) await gancho();
              return (v as (...a: unknown[]) => unknown).apply(obj, args);
            })();
          }
          const r = (v as (...a: unknown[]) => unknown).apply(obj, args);
          return r && typeof r === 'object' && !(r instanceof Promise) ? envolver(r, disparar) : r;
        };
      },
    });
  return new Proxy(db, {
    get(obj, prop, recv) {
      const v = Reflect.get(obj, prop, recv);
      if (prop !== 'selectFrom' || typeof v !== 'function')
        return typeof v === 'function' ? v.bind(obj) : v;
      return (t: string) => {
        const builder = (v as (t: string) => object).call(obj, t);
        if (t !== tabela) return builder;
        leituras += 1;
        return envolver(builder, leituras === n);
      };
    },
  });
}

type ErroTrpc = Error & { readonly code: string };
async function erroDe(p: Promise<unknown>): Promise<ErroTrpc> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && e.name === 'TRPCError' && 'code' in e) return e as ErroTrpc;
    throw e;
  }
  throw new Error('esperava TRPCError');
}

/** Duas campanhas, dois tomadores: A = 1000 + 234, B = 500. */
async function seedDoisTomadores() {
  const a = await seed.campanha();
  await seed.recebedor(a, CPF_A, 'Ana Titular');
  await seed.taxa({ campaignId: a, taxaCents: 1000, criadoEm: new Date('2033-03-05T15:00:00Z') });
  await seed.taxa({ campaignId: a, taxaCents: 234, criadoEm: new Date('2033-03-20T15:00:00Z') });
  const b = await seed.campanha();
  await seed.recebedor(b, CPF_B, 'Bruno Titular');
  await seed.taxa({ campaignId: b, taxaCents: 500, criadoEm: new Date('2033-03-07T15:00:00Z') });
}

/** Emite confirmando o plano que o admin VIU (impressão digital do plano). */
async function emitir(c = caller(), impressao?: string) {
  return c.emitir({
    mes: MES,
    confirmacao: { impressao: impressao ?? (await c.planoEmissao({ mes: MES })).impressao },
  });
}

/** Troca o recebedor da campanha (novo registro mais recente). */
async function trocarRecebedor(cpfAntigo: string, novoCpf: string, nome: string) {
  const r = await sql<{
    campanha_id: string;
  }>`SELECT campanha_id FROM recebedores WHERE cpf_titular = ${cpfAntigo} LIMIT 1`.execute(
    testDb.db,
  );
  const campanha = r.rows[0]?.campanha_id;
  if (!campanha) throw new Error('campanha não encontrada');
  await sql`UPDATE recebedores SET is_active = false WHERE campanha_id = ${campanha}::uuid`.execute(
    testDb.db,
  );
  await sql`INSERT INTO recebedores(id,campanha_id,metodo,nome_titular,cpf_titular,tipo_chave_pix,chave_pix,is_active,criada_em)
    VALUES(${randomUUID()}::uuid,${campanha}::uuid,'pix',${nome},${novoCpf},'cpf',${novoCpf},true,'2033-04-01T15:00:00Z')`.execute(
    testDb.db,
  );
}

const posts = () => fake.requisicoes.filter((r) => r.method === 'POST' && r.path === '/nfse');

describe('planoEmissao — o que a confirmação mostra', () => {
  it('lista tomadores, quantidade, total, ambiente, série e os campos fiscais', async () => {
    await seedDoisTomadores();
    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.bloqueios).toEqual([]);
    expect(plano.ambiente).toBe('2');
    expect(plano.serie).toBe('00001');
    expect(plano.quantidade).toBe(2);
    expect(plano.totalCents).toBe(1734);
    expect(plano.notas).toMatchObject([
      { tomadorCpf: CPF_B, tomadorNome: 'Bruno Titular', valorCents: 500 },
      { tomadorCpf: CPF_A, tomadorNome: 'Ana Titular', valorCents: 1234 },
    ]);
    for (const n of plano.notas) expect(n.campanhas).toHaveLength(1);
    expect(plano.impressao).toMatch(/^[0-9a-f]{64}$/);
    const tags = plano.camposFiscais.map((c) => c.tag);
    expect(tags).toEqual(
      expect.arrayContaining([
        'cTribNac',
        'cTribMun',
        'opSimpNac',
        'tribISSQN',
        'tpRetISSQN',
        'totTrib',
        'IM',
      ]),
    );
    expect(tags).not.toContain('CPF');
    expect(fake.requisicoes).toHaveLength(0);
  });

  it('pendência é PULADA: emite as possíveis e lista a pulada; resolvida, o 2º clique emite só ela', async () => {
    await seedDoisTomadores();
    const semCpf = await seed.campanha();
    await seed.recebedor(semCpf, '12345678900', 'CPF com DV errado');
    await seed.taxa({
      campaignId: semCpf,
      taxaCents: 300,
      criadoEm: new Date('2033-03-08T15:00:00Z'),
    });

    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.bloqueios).toEqual([]);
    expect(plano.quantidade).toBe(2);
    expect(plano.totalCents).toBe(1734);
    expect(plano.puladas).toEqual([
      { referencia: semCpf, motivo: 'cpf_ausente_ou_invalido', valorCents: 300 },
    ]);
    expect((await emitir()).resultados.map((x) => x.resultado)).toEqual([
      'autorizada',
      'autorizada',
    ]);
    expect(posts()).toHaveLength(2);

    // Dados completados: novo recebedor válido para a campanha pendente.
    await trocarRecebedor('12345678900', CPF_C, 'Carla Completa');
    const depois = await caller().planoEmissao({ mes: MES });
    expect(depois.bloqueios).toEqual([]);
    expect(depois.fixada).toBe(true);
    expect(depois.puladas).toEqual([]);
    expect(depois.notas).toMatchObject([{ tomadorCpf: CPF_C, valorCents: 300 }]);
    const r = await emitir();
    expect(
      r.resultados.filter((x) => x.resultado === 'autorizada').map((x) => x.tomadorCpf),
    ).toEqual([CPF_C]);
    expect(posts()).toHaveLength(3);
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((e) => [e.tomadorCpf, e.nDps])).toEqual([
      [CPF_B, '1'],
      [CPF_A, '2'],
      [CPF_C, '3'],
    ]);
    // Idempotente de novo.
    await emitir();
    expect(posts()).toHaveLength(3);
  });

  it('piso em produção: outubro/2026 nunca; NFSE_COMPETENCIA_MINIMA só sobe o piso', async () => {
    const prod = (extra: NfseEnv = {}) =>
      caller({ env: env({ NFSE_AMBIENTE: '1', NFSE_EMISSAO_PRODUCAO: 'liberada', ...extra }) });
    expect((await prod().planoEmissao({ mes: '2026-10' })).bloqueios).toContain(
      'competencia_anterior_ao_inicio',
    );
    const tentaBaixar = await prod({ NFSE_COMPETENCIA_MINIMA: '2026-01' }).planoEmissao({
      mes: '2026-10',
    });
    expect(tentaBaixar.bloqueios).toContain('competencia_anterior_ao_inicio');
    await seedDoisTomadores();
    const subiu = prod({ NFSE_COMPETENCIA_MINIMA: '2033-04' });
    expect((await subiu.planoEmissao({ mes: MES })).bloqueios).toContain(
      'competencia_anterior_ao_inicio',
    );
    expect((await erroDe(emitir(subiu))).message).toContain('competencia_anterior_ao_inicio');
    expect(fake.requisicoes).toHaveLength(0);
    expect((await prod().planoEmissao({ mes: MES })).bloqueios).not.toContain(
      'competencia_anterior_ao_inicio',
    );
  });

  it('homologação ignora o piso: emite mês fechado anterior a 2026-11 (smoke)', async () => {
    await seedDoisTomadores();
    const homolog = caller({ env: env({ NFSE_COMPETENCIA_MINIMA: '2040-01' }) });
    expect((await homolog.planoEmissao({ mes: MES })).bloqueios).toEqual([]);
    expect((await homolog.planoEmissao({ mes: '2026-10' })).bloqueios).not.toContain(
      'competencia_anterior_ao_inicio',
    );
    expect((await emitir(homolog)).resultados.map((r) => r.resultado)).toEqual([
      'autorizada',
      'autorizada',
    ]);
  });

  it.each([
    ['mês em andamento', () => ({ now: new Date('2033-03-20T15:00:00Z') }), 'mes_em_andamento'],
    ['sem certificado', () => ({ env: { ...ENV_COMPLETO } }), 'sem_certificado'],
    [
      'senha errada',
      () => ({ env: env({ NFSE_CERT_PASSWORD: 'errada' }) }),
      'certificado_ilegivel',
    ],
    [
      'produção sem a segunda chave',
      () => ({ env: env({ NFSE_AMBIENTE: '1' }) }),
      'producao_nao_liberada',
    ],
  ] as const)('bloqueia: %s', async (_nome, opts, bloqueio) => {
    await seedDoisTomadores();
    const c = caller(opts() as { env?: NfseEnv; now?: Date });
    expect((await c.planoEmissao({ mes: MES })).bloqueios).toContain(bloqueio);
    const e = await erroDe(emitir(c));
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect(fake.requisicoes).toHaveLength(0);
  });

  it('produção com NFSE_EMISSAO_PRODUCAO=liberada não é bloqueada pelo ambiente', async () => {
    await seedDoisTomadores();
    const plano = await caller({
      env: env({ NFSE_AMBIENTE: '1', NFSE_EMISSAO_PRODUCAO: 'liberada' }),
    }).planoEmissao({ mes: MES });
    expect(plano.ambiente).toBe('1');
    expect(plano.bloqueios).toEqual([]);
  });
});

describe('emitir — envio real ao (fake) Sistema Nacional', () => {
  it('confirmação diferente do plano recalculado: nada é enviado', async () => {
    await seedDoisTomadores();
    const e = await erroDe(emitir(caller(), 'f'.repeat(64)));
    expect(e.code).toBe('CONFLICT');
    expect(fake.requisicoes).toHaveLength(0);
    expect(await caller().emissoes({ mes: MES })).toEqual([]);
  });

  it('confirmação vista em homologação não emite em produção (mesma quantidade/total)', async () => {
    await seedDoisTomadores();
    const { impressao } = await caller().planoEmissao({ mes: MES });
    const prod = caller({ env: env({ NFSE_AMBIENTE: '1', NFSE_EMISSAO_PRODUCAO: 'liberada' }) });
    const e = await erroDe(emitir(prod, impressao));
    expect(e.code).toBe('CONFLICT');
    expect(fake.requisicoes).toHaveLength(0);
  });

  it('redistribuir valores entre tomadores (mesmo total) invalida a confirmação', async () => {
    await seedDoisTomadores();
    const { impressao } = await caller().planoEmissao({ mes: MES });
    // Move 100 de A para B: mesma quantidade (2) e mesmo total (1734).
    await sql`UPDATE lancamentos_financeiros SET amount_cents = 900
      WHERE amount_cents = 1000 AND tipo = 'credito_receita_plataforma'`.execute(testDb.db);
    await sql`UPDATE lancamentos_financeiros SET amount_cents = 600
      WHERE amount_cents = 500 AND tipo = 'credito_receita_plataforma'`.execute(testDb.db);
    const novo = await caller().planoEmissao({ mes: MES });
    expect([novo.quantidade, novo.totalCents]).toEqual([2, 1734]);
    expect(novo.impressao).not.toBe(impressao);
    expect((await erroDe(emitir(caller(), impressao))).code).toBe('CONFLICT');
    expect(fake.requisicoes).toHaveLength(0);
  });

  it('emite uma nota por tomador: DPS assinada, XSD válido, numeração 1..N, resultado persistido', async () => {
    await seedDoisTomadores();
    const r = await emitir();
    expect(r.resultados.map((x) => x.resultado)).toEqual(['autorizada', 'autorizada']);
    expect(posts()).toHaveLength(2);
    for (const req of posts()) expect(req.certificadoClienteCn).toBe(`EUNENEM TESTE LTDA:${CNPJ}`);

    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((e) => [e.tomadorCpf, e.nDps, e.status, e.valorCents])).toEqual([
      [CPF_B, '1', 'autorizada', 500],
      [CPF_A, '2', 'autorizada', 1234],
    ]);
    for (const e of lista) {
      expect(e.chaveAcesso).toMatch(/^\d{50}$/);
      expect(e.numeroNfse).toMatch(/^\d+$/);
      expect(e.idDps).toBe(`DPS${IBGE}2${CNPJ}00001${e.nDps.padStart(15, '0')}`);
      const { xml: dps } = await caller().xml({ id: e.id, tipo: 'dps' });
      if (dps === null) throw new Error('sem XML da DPS');
      expect(validateDpsDoLeiaute(dps).errors).toEqual([]);
      const dsig = verificarAssinaturaDps(dps);
      expect(dsig.digestConfere && dsig.assinaturaConfere).toBe(true);
      expect(dps).toContain('<tpAmb>2</tpAmb>');
      expect(dps).toContain('<serie>00001</serie>');
      expect(dps).toContain(`<nDPS>${e.nDps}</nDPS>`);
      expect(dps).toContain('<verAplic>eunenem-1</verAplic>');
      expect(dps).toContain(`<CPF>${e.tomadorCpf}</CPF>`);
      expect(dps).toContain('<dCompet>2033-03-31</dCompet>');
      // O que foi enviado é exatamente o que foi guardado.
      expect(posts().some((p) => p.xml === dps)).toBe(true);
      const { xml: nfse } = await caller().xml({ id: e.id, tipo: 'nfse' });
      expect(nfse).toContain(`Id="NFS${e.chaveAcesso}"`);
    }
  });

  it('idempotente: emitir de novo não reenvia nada', async () => {
    await seedDoisTomadores();
    await emitir();
    const r = await emitir();
    expect(r.resultados.map((x) => x.resultado)).toEqual(['ja_emitida', 'ja_emitida']);
    expect(posts()).toHaveLength(2);
    expect(await caller().emissoes({ mes: MES })).toHaveLength(2);
  });

  it('dois cliques simultâneos: cada nota é enviada uma vez só', async () => {
    await seedDoisTomadores();
    const { impressao } = await caller().planoEmissao({ mes: MES });
    const r = await Promise.allSettled([emitir(caller(), impressao), emitir(caller(), impressao)]);
    // Um fixa e envia; o outro encontra a competência já fixada (plano mudou) ou nada a fazer.
    expect(r.some((x) => x.status === 'fulfilled')).toBe(true);
    expect(posts()).toHaveLength(2);
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((e) => e.status)).toEqual(['autorizada', 'autorizada']);
    expect(lista.map((e) => e.nDps).sort()).toEqual(['1', '2']);
  });

  it('timeout depois de registrar: fica incerta; o retry consulta e NÃO reenvia', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['registrar_e_derrubar', 'autorizar'];
    const r1 = await emitir();
    expect(r1.resultados.map((x) => x.resultado)).toEqual(['incerta', 'autorizada']);
    expect(posts()).toHaveLength(2);

    const r2 = await emitir();
    expect(r2.resultados.map((x) => x.resultado)).toEqual(['autorizada', 'ja_emitida']);
    expect(posts()).toHaveLength(2); // nenhum POST novo
    expect(fake.requisicoes.some((q) => q.method === 'GET' && q.path.startsWith('/dps/'))).toBe(
      true,
    );
    const [b] = await caller().emissoes({ mes: MES });
    expect(b?.status).toBe('autorizada');
    expect(b?.chaveAcesso).toBe([...fake.notas.values()][0]?.chave);
  });

  it('conexão caiu sem registrar: o retry consulta (404) e reenvia com o MESMO Id/número', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['derrubar'];
    await emitir();
    const antes = await caller().emissoes({ mes: MES });
    expect(antes[0]?.status).toBe('incerta');
    await emitir();
    const depois = await caller().emissoes({ mes: MES });
    expect(depois[0]?.status).toBe('autorizada');
    expect(depois[0]?.idDps).toBe(antes[0]?.idDps);
    expect(depois.map((e) => e.nDps)).toEqual(['1', '2']);
    expect(posts()).toHaveLength(3);
  });

  it('rejeição: guarda os erros; o retry reaproveita o número (sem lacuna)', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = [
      { rejeitar: { codigo: 'E0312', descricao: 'cTribNac nao habilitado' } },
      'autorizar',
    ];
    await emitir();
    const [b] = await caller().emissoes({ mes: MES });
    expect(b?.status).toBe('rejeitada');
    expect(b?.erros).toEqual([
      { codigo: 'E0312', descricao: 'cTribNac nao habilitado', complemento: null },
    ]);
    await emitir();
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((e) => [e.nDps, e.status])).toEqual([
      ['1', 'autorizada'],
      ['2', 'autorizada'],
    ]);
    expect(lista[0]?.erros).toBeNull();
  });

  it('homologação e produção têm numeração e idempotência separadas', async () => {
    await seedDoisTomadores();
    await emitir();
    const prod = caller({ env: env({ NFSE_AMBIENTE: '1', NFSE_EMISSAO_PRODUCAO: 'liberada' }) });
    await emitir(prod);
    const p = await prod.emissoes({ mes: MES });
    expect(p.map((e) => [e.ambiente, e.nDps])).toEqual([
      ['1', '1'],
      ['1', '2'],
    ]);
    expect(posts().filter((q) => q.xml?.includes('<tpAmb>1</tpAmb>'))).toHaveLength(2);
    expect(await caller().emissoes({ mes: MES })).toHaveLength(2);
  });
});

describe('competência fixada na primeira emissão (sem dupla tributação)', () => {
  it('troca de recebedor DEPOIS de autorizada: bloqueia com divergência, nenhuma nota nova', async () => {
    await seedDoisTomadores();
    await emitir();
    expect(posts()).toHaveLength(2);
    await trocarRecebedor(CPF_A, CPF_C, 'Carla Nova');
    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.bloqueios).toContain('competencia_divergente');
    expect(plano.divergencias.join('\n')).toContain(CPF_C);
    const e = await erroDe(emitir());
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect(e.message).toContain('competencia_divergente');
    expect(posts()).toHaveLength(2);
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((x) => x.tomadorCpf).sort()).toEqual([CPF_B, CPF_A].sort());
    expect(lista.reduce((s, x) => s + x.valorCents, 0)).toBe(1734);
  });

  it('troca de recebedor com nota INCERTA: não emite para o novo CPF; Consultar recupera a original', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['autorizar', 'registrar_e_derrubar'];
    await emitir();
    const incerta = (await caller().emissoes({ mes: MES })).find((x) => x.status === 'incerta');
    expect(incerta?.tomadorCpf).toBe(CPF_A);
    await trocarRecebedor(CPF_A, CPF_C, 'Carla Nova');
    expect((await erroDe(emitir())).message).toContain('competencia_divergente');
    expect(posts()).toHaveLength(2);
    const r = await caller().consultar({ id: incerta?.id ?? '' });
    expect(r).toMatchObject({ status: 'autorizada', tomadorCpf: CPF_A, valorCents: 1234 });
    expect(posts()).toHaveLength(2);
  });

  it('todas as notas da competência são reservadas antes do primeiro envio', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['derrubar', 'derrubar'];
    await emitir();
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.map((x) => [x.tomadorCpf, x.nDps, x.valorCents])).toEqual([
      [CPF_B, '1', 500],
      [CPF_A, '2', 1234],
    ]);
  });

  it('retry reenvia com os valores FIXADOS; o plano de retry só lista o que falta enviar', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['autorizar', { rejeitar: { codigo: 'E0312', descricao: 'x' } }];
    await emitir();
    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.bloqueios).toEqual([]);
    expect(plano.notas.map((n) => n.tomadorCpf)).toEqual([CPF_A]);
    await emitir();
    expect((await caller().emissoes({ mes: MES })).map((x) => x.status)).toEqual([
      'autorizada',
      'autorizada',
    ]);
  });
});

describe('fixação concorrente da competência', () => {
  const nota = (cpf: string, campanha: string) => ({
    tomadorCpf: cpf,
    tomadorNome: 'X',
    valorCents: 1234,
    campanhas: [campanha],
  });
  const fixar = (cpf: string) =>
    gravarNotas(testDb.db, {
      idsEsperados: [],
      ambiente: '2',
      serie: '00001',
      mes: MES,
      notas: [nota(cpf, randomUUID())],
      autorId: randomUUID(),
      now: NOW,
      idDps: (n) => `DPS${IBGE}2${CNPJ}00001${n.padStart(15, '0')}`,
    });

  it('primeiros cliques simultâneos com CPFs disjuntos: só um fixa o mês', async () => {
    const r = await Promise.all([fixar(CPF_A), fixar(CPF_C), fixar(CPF_B)]);
    expect(r.filter((x) => x !== null)).toHaveLength(1);
    const linhas = await sql<{
      tomador_cpf: string;
    }>`SELECT tomador_cpf FROM nfse_emissoes WHERE competencia = ${MES}`.execute(testDb.db);
    expect(linhas.rows).toHaveLength(1);
    const seq = await sql<{ proximo: string }>`SELECT proximo FROM nfse_numeracao`.execute(
      testDb.db,
    );
    expect(seq.rows[0]?.proximo).toBe('2'); // nenhum número consumido pelos que desistiram
  });

  it('mês já fixado com outro CPF: a fixação seguinte é recusada', async () => {
    expect(await fixar(CPF_A)).not.toBeNull();
    expect(await fixar(CPF_C)).toBeNull();
  });

  it('barreira: nota gravada por outro clique DEPOIS da confirmação não é enviada por este', async () => {
    await seedDoisTomadores();
    const pendente = await seed.campanha();
    await seed.recebedor(pendente, '12345678900', 'CPF com DV errado');
    await seed.taxa({
      campaignId: pendente,
      taxaCents: 300,
      criadoEm: new Date('2033-03-08T15:00:00Z'),
    });
    fake.proximaEmissao = ['autorizar', { rejeitar: { codigo: 'E1', descricao: 'x' } }];
    await emitir(); // B autorizada, A rejeitada; campanha pendente pulada
    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.notas.map((n) => n.tomadorCpf)).toEqual([CPF_A]);

    // Entre a conferência do plano e o laço de envio, outro clique resolve a
    // pendência e grava CPF C. Barreira: a 3ª leitura de nfse_emissoes do
    // emitir (1ª = plano, 2ª = notas vistas, 3ª = laço de envio).
    const linhas = async () =>
      (await sql<{ id: string }>`SELECT id FROM nfse_emissoes`.execute(testDb.db)).rows.map(
        (r) => r.id,
      );
    let gravadaC = false;
    const gravarC = async () => {
      gravadaC = true;
      await trocarRecebedor('12345678900', CPF_C, 'Carla');
      const criadas = await gravarNotas(testDb.db, {
        ambiente: '2',
        serie: '00001',
        mes: MES,
        notas: [
          { tomadorCpf: CPF_C, tomadorNome: 'Carla', valorCents: 300, campanhas: [pendente] },
        ],
        idsEsperados: await linhas(),
        autorId: randomUUID(),
        now: NOW,
        idDps: (n) => `DPS${IBGE}2${CNPJ}00001${n.padStart(15, '0')}`,
      });
      expect(criadas).not.toBeNull();
    };
    const auth = adminAuthOverrides();
    const deps = {
      ...auth.depsOverrides,
      db: comGanchoNaLeitura(testDb.db, 'nfse_emissoes', 3, gravarC),
      clock: () => NOW,
      logPiiHashSalt: 'nfse-emissao-integration-salt',
      nfse: parseNfseConfig(env()),
      nfseClienteSefin: fabricaFake,
    } as unknown as ServerDeps;
    const c = appRouter.createCaller({
      deps,
      headers: auth.headers,
      resHeaders: new Headers(),
    } as TrpcContext).admin.notaFiscal;
    const r = await c.emitir({ mes: MES, confirmacao: { impressao: plano.impressao } });
    expect(gravadaC).toBe(true);
    expect(r.resultados.map((x) => [x.tomadorCpf, x.resultado])).toEqual(
      expect.arrayContaining([[CPF_A, 'autorizada']]),
    );
    expect(r.resultados.some((x) => x.tomadorCpf === CPF_C)).toBe(false);
    const lista = await caller().emissoes({ mes: MES });
    expect(lista.find((e) => e.tomadorCpf === CPF_C)?.status).toBe('pendente');
    expect(posts().filter((p) => p.xml?.includes(`<CPF>${CPF_C}</CPF>`))).toHaveLength(0);
  });

  it('série configurada mudou depois da fixação: retry bloqueado, nada enviado', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['autorizar', { rejeitar: { codigo: 'E1', descricao: 'x' } }];
    await emitir();
    const outra = caller({ env: env({ NFSE_SERIE: '00002' }) });
    const plano = await outra.planoEmissao({ mes: MES });
    expect(plano.bloqueios).toContain('serie_divergente');
    expect((await erroDe(emitir(outra))).message).toContain('serie_divergente');
    expect(posts()).toHaveLength(2);
  });
});

describe('consultar e cancelar', () => {
  async function emitidas() {
    await seedDoisTomadores();
    await emitir();
    return caller().emissoes({ mes: MES });
  }

  it('cancelar exige redigitar a chave; motivo curto é recusado', async () => {
    const [b] = await emitidas();
    if (!b?.chaveAcesso) throw new Error('sem chave');
    const curto = await erroDe(
      caller().cancelar({ id: b.id, motivo: '1', texto: 'curto', confirmacaoChave: b.chaveAcesso }),
    );
    expect(curto.code).toBe('BAD_REQUEST');
    const errada = await erroDe(
      caller().cancelar({
        id: b.id,
        motivo: '1',
        texto: 'Erro na emissão do valor',
        confirmacaoChave: '9'.repeat(50),
      }),
    );
    expect(errada.message).toBe('nfse_confirmacao_nao_confere');
    expect(fake.requisicoes.filter((q) => q.path.includes('/eventos'))).toHaveLength(0);
  });

  it('cancela: evento assinado e válido enviado, status cancelada, não cancela duas vezes', async () => {
    const [b] = await emitidas();
    if (!b?.chaveAcesso) throw new Error('sem chave');
    const r = await caller().cancelar({
      id: b.id,
      motivo: '1',
      texto: 'Erro na emissão do valor',
      confirmacaoChave: b.chaveAcesso,
    });
    expect(r.status).toBe('cancelada');
    expect(r.cancelamentoMotivo).toBe('1');
    const pedido = fake.requisicoes.find(
      (q) => q.method === 'POST' && q.path === `/nfse/${b.chaveAcesso}/eventos`,
    );
    if (!pedido?.xml) throw new Error('sem pedido de evento');
    const dsig = verificarAssinaturaPedidoEvento(pedido.xml);
    expect(dsig.digestConfere && dsig.assinaturaConfere).toBe(true);
    expect(pedido.xml).toContain(`<chNFSe>${b.chaveAcesso}</chNFSe>`);
    expect(pedido.xml).toContain('<tpAmb>2</tpAmb>');
    const de_novo = await erroDe(
      caller().cancelar({
        id: b.id,
        motivo: '1',
        texto: 'Erro na emissão do valor',
        confirmacaoChave: b.chaveAcesso,
      }),
    );
    expect(de_novo.message).toContain('ja_cancelada');
    // Cancelada não é reemitida.
    expect((await emitir()).resultados.map((x) => x.resultado)).toEqual([
      'ja_emitida',
      'ja_emitida',
    ]);
  });

  it('cancelamento sem resposta: fica incerto; a nova tentativa consulta o evento e não reenvia', async () => {
    const [b] = await emitidas();
    if (!b?.chaveAcesso) throw new Error('sem chave');
    fake.reacaoEvento = 'registrar_e_derrubar';
    const r1 = await caller().cancelar({
      id: b.id,
      motivo: '9',
      texto: 'Cancelamento solicitado pelo contador',
      confirmacaoChave: b.chaveAcesso,
    });
    expect(r1).toMatchObject({ status: 'autorizada', cancelamentoStatus: 'incerto' });
    const r2 = await caller().cancelar({
      id: b.id,
      motivo: '9',
      texto: 'Cancelamento solicitado pelo contador',
      confirmacaoChave: b.chaveAcesso,
    });
    expect(r2.status).toBe('cancelada');
    expect(
      fake.requisicoes.filter((q) => q.method === 'POST' && q.path.endsWith('/eventos')),
    ).toHaveLength(1);
  });

  it('cancelamento recusado: continua autorizada com os erros', async () => {
    const [b] = await emitidas();
    if (!b?.chaveAcesso) throw new Error('sem chave');
    fake.reacaoEvento = { rejeitar: { codigo: 'E0830', descricao: 'prazo expirado' } };
    const r = await caller().cancelar({
      id: b.id,
      motivo: '2',
      texto: 'Serviço não prestado no mês',
      confirmacaoChave: b.chaveAcesso,
    });
    expect(r).toMatchObject({
      status: 'autorizada',
      cancelamentoStatus: 'rejeitado',
      erros: [{ codigo: 'E0830' }],
    });
  });

  it('consultar resolve uma incerta e detecta cancelamento feito fora do sistema', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = ['registrar_e_derrubar'];
    await emitir();
    const [b] = await caller().emissoes({ mes: MES });
    if (!b) throw new Error('sem emissão');
    const consultada = await caller().consultar({ id: b.id });
    expect(consultada.status).toBe('autorizada');
    // Cancelada direto no portal: a consulta enxerga o evento.
    const nota = fake.notas.get(consultada.chaveAcesso ?? '');
    if (!nota) throw new Error('sem nota no fake');
    nota.cancelada = true;
    nota.eventoXml = '<evento/>';
    expect((await caller().consultar({ id: b.id })).status).toBe('cancelada');
  });

  it('consultar uma rejeitada com consulta inconclusiva NÃO a rebaixa para incerta (smoke 26/11)', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = [
      { rejeitar: { codigo: 'E1235', descricao: 'Falha no esquema XML do DF-e.' } },
      'autorizar',
    ];
    await emitir();
    const rejeitada = (await caller().emissoes({ mes: MES })).find((e) => e.status === 'rejeitada');
    if (!rejeitada) throw new Error('sem rejeitada');
    fake.reacaoConsultaDps = 'erro_500';
    expect((await caller().consultar({ id: rejeitada.id })).status).toBe('rejeitada');
    fake.reacaoConsultaDps = 'normal';
    expect((await caller().consultar({ id: rejeitada.id })).status).toBe('rejeitada');
    expect(
      fake.requisicoes.filter((q) => q.path === `/dps/${rejeitada.idDps.slice(3)}`),
    ).toHaveLength(2);
  });

  it('danfse devolve o PDF do ADN', async () => {
    const [b] = await emitidas();
    if (!b) throw new Error('sem emissão');
    const { pdfBase64 } = await caller().danfse({ id: b.id });
    expect(
      Buffer.from(pdfBase64 ?? '', 'base64')
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
  });
});

describe('segredos', () => {
  it('senha, chave privada e PFX não aparecem em respostas, linhas do banco nem no XML enviado', async () => {
    await seedDoisTomadores();
    fake.proximaEmissao = [{ rejeitar: { codigo: 'E1', descricao: 'x' } }];
    const c = caller();
    const saidas: unknown[] = [
      await c.planoEmissao({ mes: MES }),
      await emitir(c),
      await c.emissoes({ mes: MES }),
    ];
    const linhas = await sql`SELECT * FROM nfse_emissoes`.execute(testDb.db);
    const tudo = [
      JSON.stringify(saidas),
      inspect(saidas, { depth: 10 }),
      JSON.stringify(linhas.rows),
      JSON.stringify(fake.requisicoes),
    ].join('\n');
    expect(tudo).not.toContain(pfx.senha);
    expect(tudo).not.toContain(pfx.chavePrivadaBase64.slice(0, 64));
    expect(tudo).not.toContain(pfx.pfx.toString('base64').slice(0, 64));
  });
});
