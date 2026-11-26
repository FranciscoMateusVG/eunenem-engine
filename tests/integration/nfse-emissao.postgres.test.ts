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
import type { FabricaClienteSefin } from '../../apps/eunenem-server/server/nfse/emissao.js';
import { criarClienteSefin } from '../../apps/eunenem-server/server/nfse/sefin-cliente.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { type FakeSefin, iniciarFakeSefin } from '../helpers/fake-sefin.js';
import { gerarPfxDeTeste, type TestPfx } from '../helpers/nfse-test-pfx.js';
import { validateDps } from '../helpers/nfse-xsd.js';
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

async function emitir(c = caller(), confirmacao = { quantidade: 2, totalCents: 1734 }) {
  return c.emitir({ mes: MES, confirmacao });
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
    expect(plano.notas).toEqual([
      { tomadorCpf: CPF_B, tomadorNome: 'Bruno Titular', valorCents: 500 },
      { tomadorCpf: CPF_A, tomadorNome: 'Ana Titular', valorCents: 1234 },
    ]);
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

  it('pendência de tomador bloqueia a competência inteira', async () => {
    await seedDoisTomadores();
    const semCpf = await seed.campanha();
    await seed.recebedor(semCpf, '12345678900', 'CPF com DV errado');
    await seed.taxa({
      campaignId: semCpf,
      taxaCents: 300,
      criadoEm: new Date('2033-03-08T15:00:00Z'),
    });
    const plano = await caller().planoEmissao({ mes: MES });
    expect(plano.bloqueios).toContain('pendencias_de_tomador');
    const e = await erroDe(emitir(caller(), { quantidade: 2, totalCents: 1734 }));
    expect(e.code).toBe('PRECONDITION_FAILED');
    expect(e.message).toContain('pendencias_de_tomador');
    expect(fake.requisicoes).toHaveLength(0);
    expect(await caller().emissoes({ mes: MES })).toEqual([]);
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
    const e = await erroDe(emitir(caller(), { quantidade: 2, totalCents: 1733 }));
    expect(e.code).toBe('CONFLICT');
    expect(fake.requisicoes).toHaveLength(0);
    expect(await caller().emissoes({ mes: MES })).toEqual([]);
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
      expect(validateDps(dps).errors).toEqual([]);
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
    await Promise.all([emitir(), emitir()]);
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
