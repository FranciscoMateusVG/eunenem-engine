import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadReceitaDashboard } from '../../apps/eunenem-server/server/admin-receita.js';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import { type NfseEnv, parseNfseConfig } from '../../apps/eunenem-server/server/nfse/config.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { gerarPfxDeTeste, type TestPfx } from '../helpers/nfse-test-pfx.js';
import { validateDps } from '../helpers/nfse-xsd.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { verificarAssinaturaDps } from '../helpers/xmldsig-verify.js';

/**
 * aperture-uj78j — prévia mensal da NFS-e contra Postgres real.
 *
 * Datas em 2032: o container é compartilhado e admin-receita usa 2031.
 * NOW fica depois de todos os meses usados, salvo onde o teste diz o contrário.
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000a5e1';
const NOW = new Date('2032-12-15T15:00:00.000Z');

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed;

beforeAll(async () => {
  testDb = await createTestDatabase();
  seed = new ReceitaLedgerSeed(testDb.db);
}, 60_000);

beforeEach(async () => {
  await seed.wipe();
});

afterAll(async () => {
  await seed.wipe();
  await testDb.teardown();
});

function receitaDoMes(de: string, ate: string) {
  return loadReceitaDashboard(testDb.db, {
    platformId: ID_PLATAFORMA_EUNENEM,
    periodo: { de, ate, granularidade: 'mes' },
    now: NOW,
  });
}

/**
 * Cenário de bordas usado por vários testes. Março/2032 em SP vai de
 * 2032-03-01T03:00Z até 2032-04-01T03:00Z (BRT, UTC−3, sem horário de verão).
 */
async function seedBordasDeMarco() {
  const campanha = await seed.campanha();
  // 28/02 23:59:59 em SP ⇒ fevereiro, embora já seja março em UTC.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 7,
    criadoEm: new Date('2032-03-01T02:59:59Z'),
  });
  // 01/03 00:00 em SP ⇒ março.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 100,
    criadoEm: new Date('2032-03-01T03:00:00Z'),
  });
  // 31/03 23:59 em SP ⇒ março, embora já seja abril em UTC.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 20,
    criadoEm: new Date('2032-04-01T02:59:00Z'),
  });
  // 01/04 00:00 em SP ⇒ abril.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 3000,
    criadoEm: new Date('2032-04-01T03:00:00Z'),
  });
  // Março, cancelada em abril: conta +500 em março e −500 em abril.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 500,
    criadoEm: new Date('2032-03-10T15:00:00Z'),
    canceladoEm: new Date('2032-04-05T15:00:00Z'),
    status: 'estornado',
  });
  // Abril, cancelada em maio: maio fica negativo (−4000).
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 4000,
    criadoEm: new Date('2032-04-20T15:00:00Z'),
    canceladoEm: new Date('2032-05-02T15:00:00Z'),
    status: 'estornado',
  });
  // Adicional de cartão em março: não é receita.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 1,
    criadoEm: new Date('2032-03-15T15:00:00Z'),
    metodo: 'credit_card',
    adicionalCents: 9999,
  });
  // Outra plataforma em março: fora.
  const alheia = await seed.campanha(OTHER_PLATFORM);
  await seed.taxa({
    campaignId: alheia,
    taxaCents: 77777,
    criadoEm: new Date('2032-03-15T15:00:00Z'),
  });
}

/** Esperado por mês em SP, derivado à mão das linhas acima. */
const ESPERADO = {
  '2032-02': 7,
  '2032-03': 100 + 20 + 500 + 1, // 621
  '2032-04': 3000 + 4000 - 500, // 6500
  '2032-05': -4000,
  '2032-06': 0,
} as const;

describe('fixtures de borda provadas pela Receita (pré-condição da prévia)', () => {
  it('loadReceitaDashboard enxerga cada mês como derivado à mão', async () => {
    await seedBordasDeMarco();
    const meses = [
      ['2032-02', '2032-02-01', '2032-03-01'],
      ['2032-03', '2032-03-01', '2032-04-01'],
      ['2032-04', '2032-04-01', '2032-05-01'],
      ['2032-05', '2032-05-01', '2032-06-01'],
      ['2032-06', '2032-06-01', '2032-07-01'],
    ] as const;
    for (const [mes, de, ate] of meses) {
      const d = await receitaDoMes(de, ate);
      expect(d.cards.periodo.resultadoDeTaxasCents, mes).toBe(ESPERADO[mes]);
    }
  });
});

// ── Router real (admin.notaFiscal.previaMensal) ───────────────────────────

/** CNPJ sintético com DV válido; IBGE de Belo Horizonte. */
const CNPJ = '11222333000181';
const OUTRO_CNPJ = '11444777000161';
const IBGE = '3106200';
const BASE_ENV: NfseEnv = { NFSE_PRESTADOR_CNPJ: CNPJ, NFSE_MUNICIPIO_IBGE: IBGE };

function caller(input: { env?: NfseEnv; now?: Date; auth?: 'admin' | 'anon' | 'nao_admin' } = {}) {
  const auth = adminAuthOverrides();
  const modo = input.auth ?? 'admin';
  const deps = {
    ...auth.depsOverrides,
    // Sessão válida, mas o e-mail não está na allowlist.
    ...(modo === 'nao_admin' ? { adminAllowedEmails: new Set(['outra-pessoa@example.com']) } : {}),
    db: testDb.db,
    clock: () => input.now ?? NOW,
    logPiiHashSalt: 'nfse-previa-integration-salt',
    nfse: parseNfseConfig(input.env ?? BASE_ENV),
  } as unknown as ServerDeps;
  const headers = modo === 'anon' ? new Headers() : auth.headers;
  const ctx: TrpcContext = { deps, headers, resHeaders: new Headers() };
  return appRouter.createCaller(ctx);
}

const previa = (mes: string, opts: Parameters<typeof caller>[0] = {}) =>
  caller(opts).admin.notaFiscal.previaMensal({ mes });

/** TRPCError do caller (o pacote @trpc/server só existe em apps/eunenem-server). */
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

const vServ = (xml: string) => /<vServ>([^<]+)<\/vServ>/.exec(xml)?.[1];

describe('valor da prévia = Resultado de taxas da Receita (mesmo mês, SP)', () => {
  it('cada mês bate com admin.receita.dashboard e com o derivado à mão', async () => {
    await seedBordasDeMarco();
    const c = caller();
    const meses = [
      ['2032-02', '2032-02-01', '2032-03-01'],
      ['2032-03', '2032-03-01', '2032-04-01'],
      ['2032-04', '2032-04-01', '2032-05-01'],
      ['2032-05', '2032-05-01', '2032-06-01'],
      ['2032-06', '2032-06-01', '2032-07-01'],
    ] as const;
    for (const [mes, de, ate] of meses) {
      const p = await c.admin.notaFiscal.previaMensal({ mes });
      const r = await c.admin.receita.dashboard({ de, ate, granularidade: 'mes' });
      expect(p.periodo, mes).toEqual({ de, ate });
      expect(p.timezone).toBe('America/Sao_Paulo');
      expect(p.valor, mes).toEqual({
        taxasRegistradasCents: r.cards.periodo.taxasRegistradasCents,
        cancelamentosCents: r.cards.periodo.cancelamentosCents,
        resultadoDeTaxasCents: r.cards.periodo.resultadoDeTaxasCents,
        lancamentosRegistrados: r.cards.periodo.lancamentosRegistrados,
        lancamentosCancelados: r.cards.periodo.lancamentosCancelados,
        pagamentosComTaxa: r.cards.periodo.pagamentosComTaxa,
      });
      expect(p.valor.resultadoDeTaxasCents, mes).toBe(ESPERADO[mes]);
      expect(p.porMeioProvedor, mes).toEqual(r.porMeioProvedor);
    }
  });

  it('bordas: 23:59 do último dia em SP entra no mês; 00:00 UTC do dia 1 não', async () => {
    await seedBordasDeMarco();
    const fev = await previa('2032-02');
    const mar = await previa('2032-03');
    // Fevereiro só tem a linha de 28/02 23:59:59 SP (= 01/03 02:59:59 UTC).
    expect(fev.valor.taxasRegistradasCents).toBe(7);
    // Março: 100 (01/03 00:00 SP) + 20 (31/03 23:59 SP = 01/04 UTC) + 500 + 1.
    expect(mar.valor.taxasRegistradasCents).toBe(621);
    expect(mar.dps.status).toBe('gerada');
    if (mar.dps.status !== 'gerada') return;
    expect(mar.dps.valorServico).toBe('6.21');
    expect(vServ(mar.dps.xml)).toBe('6.21');
    expect(mar.dps.campos.find((f) => f.tag === 'vServ')).toMatchObject({
      valor: '6.21',
      origem: 'ledger',
    });
  });

  it('cancelamento no mês seguinte: entra no mês da taxa e abate no mês do cancelamento', async () => {
    await seedBordasDeMarco();
    const abr = await previa('2032-04');
    expect(abr.valor).toMatchObject({
      taxasRegistradasCents: 7000,
      cancelamentosCents: 500,
      resultadoDeTaxasCents: 6500,
    });
    if (abr.dps.status !== 'gerada') throw new Error(`abril deveria gerar DPS: ${abr.dps.status}`);
    expect(vServ(abr.dps.xml)).toBe('65.00');
  });

  it('mês negativo: sem DPS, sem XML, com aviso', async () => {
    await seedBordasDeMarco();
    const mai = await previa('2032-05');
    expect(mai.valor.resultadoDeTaxasCents).toBe(-4000);
    expect(mai.dps).toEqual({ status: 'sem_valor' });
    expect(mai.avisos).toContain('resultado_nao_positivo');
    expect(JSON.stringify(mai)).not.toContain('<DPS');
  });

  it('mês vazio: zero, sem DPS', async () => {
    const jun = await previa('2032-06');
    expect(jun.valor).toEqual({
      taxasRegistradasCents: 0,
      cancelamentosCents: 0,
      resultadoDeTaxasCents: 0,
      lancamentosRegistrados: 0,
      lancamentosCancelados: 0,
      pagamentosComTaxa: 0,
    });
    expect(jun.dps).toEqual({ status: 'sem_valor' });
    expect(jun.avisos).toContain('resultado_nao_positivo');
  });

  it('só a plataforma EuNeném: taxa de outra plataforma não vira nota', async () => {
    const alheia = await seed.campanha(OTHER_PLATFORM);
    await seed.taxa({
      campaignId: alheia,
      taxaCents: 5000,
      criadoEm: new Date('2032-07-10T15:00:00Z'),
    });
    const jul = await previa('2032-07');
    expect(jul.valor.resultadoDeTaxasCents).toBe(0);
    expect(jul.dps).toEqual({ status: 'sem_valor' });
  });

  it('adicional de cartão fica fora do valor da nota', async () => {
    const campanha = await seed.campanha();
    await seed.taxa({
      campaignId: campanha,
      taxaCents: 300,
      criadoEm: new Date('2032-08-10T15:00:00Z'),
      metodo: 'credit_card',
      adicionalCents: 4900,
    });
    const ago = await previa('2032-08');
    expect(ago.valor.resultadoDeTaxasCents).toBe(300);
    expect(ago.adicionalCartao.registradoCents).toBe(4900);
    if (ago.dps.status !== 'gerada') throw new Error(ago.dps.status);
    expect(vServ(ago.dps.xml)).toBe('3.00');
  });
});

describe('mês corrente e futuro (relógio em SP)', () => {
  it('mês corrente sai com aviso; mês seguinte é BAD_REQUEST', async () => {
    const dez = await previa('2032-12');
    expect(dez.situacao).toBe('em_andamento');
    expect(dez.avisos).toContain('mes_em_andamento');
    const e = await erroDe(previa('2033-01'));
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).toBe('nfse_mes_futuro');
  });

  it('31/12 23:00 em SP (já 01/01 em UTC): janeiro ainda é futuro', async () => {
    const now = new Date('2033-01-01T02:00:00Z');
    expect((await previa('2032-12', { now })).situacao).toBe('em_andamento');
    expect((await erroDe(previa('2033-01', { now }))).code).toBe('BAD_REQUEST');
  });

  it('mês malformado é BAD_REQUEST antes de tocar o banco', async () => {
    for (const mes of ['2032-13', '2032-1', '32-01', '2032-00', '']) {
      expect((await erroDe(previa(mes))).code, mes).toBe('BAD_REQUEST');
    }
  });
});

describe('acesso', () => {
  it('sem sessão: UNAUTHORIZED', async () => {
    expect((await erroDe(previa('2032-03', { auth: 'anon' }))).code).toBe('UNAUTHORIZED');
  });

  it('sessão válida de quem não é admin: FORBIDDEN, sem valor', async () => {
    await seedBordasDeMarco();
    const e = await erroDe(previa('2032-03', { auth: 'nao_admin' }));
    expect(e.code).toBe('FORBIDDEN');
    expect(JSON.stringify({ message: e.message, cause: String(e.cause) })).not.toContain('6.21');
  });
});

describe('configuração', () => {
  it('sem CNPJ/município: config_incompleta com os nomes das variáveis', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03', { env: {} });
    expect(p.valor.resultadoDeTaxasCents).toBe(621);
    expect(p.dps.status).toBe('config_incompleta');
    if (p.dps.status !== 'config_incompleta') return;
    expect([...p.dps.faltando].sort()).toEqual(['NFSE_MUNICIPIO_IBGE', 'NFSE_PRESTADOR_CNPJ']);
    expect(p.avisos).toContain('config_com_problemas');
  });
});

// ── Conformidade com o XSD oficial v1.01 ──────────────────────────────────

describe('DPS valida contra o XSD oficial (xmllint)', () => {
  it('sem assinatura', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03');
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(validateDps(p.dps.xml)).toEqual({ ok: true, errors: [] });
  });

  it('com todos os opcionais de env preenchidos', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03', {
      env: {
        ...BASE_ENV,
        NFSE_AMBIENTE: '1',
        NFSE_CTRIB_NAC: '010501',
        NFSE_OP_SIMP_NAC: '3',
        NFSE_REG_AP_TRIB_SN: '1',
        NFSE_REG_ESP_TRIB: '9',
        NFSE_TRIB_ISSQN: '1',
        NFSE_TP_RET_ISSQN: '2',
        NFSE_ALIQUOTA_ISS: '2.00',
        NFSE_INSCRICAO_MUNICIPAL: '1234567',
        NFSE_CNBS: '109012100',
        NFSE_DESCRICAO_SERVICO: 'Intermediação & taxas <EuNeném> {competencia}',
      },
    });
    expect(p.configuracao.problemas).toEqual([]);
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.xml).toContain('março/2032');
    expect(validateDps(p.dps.xml)).toEqual({ ok: true, errors: [] });
  });

  it('assinada', async () => {
    await seedBordasDeMarco();
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const p = await previa('2032-03', { env: envComCert(pfx, 'base64') });
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.assinatura.status).toBe('assinada');
    expect(validateDps(p.dps.xml)).toEqual({ ok: true, errors: [] });
  });
});

// ── Assinatura XMLDsig ────────────────────────────────────────────────────

function envComCert(pfx: TestPfx, fonte: 'base64' | 'caminho', extra: NfseEnv = {}): NfseEnv {
  if (fonte === 'base64') {
    return {
      ...BASE_ENV,
      NFSE_CERT_BASE64: pfx.pfx.toString('base64'),
      NFSE_CERT_PASSWORD: pfx.senha,
      ...extra,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'nfse-pfx-'));
  const path = join(dir, 'teste.pfx');
  writeFileSync(path, pfx.pfx, { mode: 0o600 });
  return { ...BASE_ENV, NFSE_CERT_PATH: path, NFSE_CERT_PASSWORD: pfx.senha, ...extra };
}

describe('assinatura XMLDsig (verificada sem o xml-crypto)', () => {
  let pfx: TestPfx;
  beforeAll(() => {
    pfx = gerarPfxDeTeste({ cnpj: CNPJ });
  });

  it('PFX por caminho: assina o infDPS e a assinatura confere com o certificado', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03', { env: envComCert(pfx, 'caminho') });
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.assinatura).toEqual({
      status: 'assinada',
      certificadoCnpj: CNPJ,
      certificadoConfereComPrestador: true,
      certificadoValidoAte: pfx.validoAte.toISOString(),
    });
    expect(p.avisos).not.toContain('xml_nao_assinado');

    const check = verificarAssinaturaDps(p.dps.xml);
    expect(check.idReferenciado).toBe(p.dps.idDps);
    expect(check.algoritmos).toEqual({
      c14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      assinatura: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });
    expect(check.certificadoBase64).toBe(pfx.certificadoBase64);
    expect(check.digestConfere).toBe(true);
    expect(check.assinaturaConfere).toBe(true);
  });

  it('adulterar o valor depois de assinado quebra o digest', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03', { env: envComCert(pfx, 'base64') });
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    const adulterado = p.dps.xml.replace('<vServ>6.21</vServ>', '<vServ>9.21</vServ>');
    expect(adulterado).not.toBe(p.dps.xml);
    const check = verificarAssinaturaDps(adulterado);
    expect(check.digestConfere).toBe(false);
    // SignedInfo intacto: a assinatura dele ainda confere; é o digest que denuncia.
    expect(check.assinaturaConfere).toBe(true);
  });

  it('sem certificado: XML sai sem Signature e sinalizado', async () => {
    await seedBordasDeMarco();
    const p = await previa('2032-03');
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.assinatura).toEqual({ status: 'nao_assinada', motivo: 'sem_certificado' });
    expect(p.avisos).toContain('xml_nao_assinado');
    expect(p.dps.xml).not.toContain('Signature');
  });

  it('certificado de outro CNPJ assina, mas avisa', async () => {
    await seedBordasDeMarco();
    const outro = gerarPfxDeTeste({ cnpj: OUTRO_CNPJ });
    const p = await previa('2032-03', { env: envComCert(outro, 'base64') });
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.assinatura).toMatchObject({
      status: 'assinada',
      certificadoCnpj: OUTRO_CNPJ,
      certificadoConfereComPrestador: false,
    });
    expect(p.avisos).toContain('certificado_de_outro_cnpj');
  });

  it('certificado vencido em relação ao relógio: avisa', async () => {
    await seedBordasDeMarco();
    const vencido = gerarPfxDeTeste({
      cnpj: CNPJ,
      validoDe: new Date('2030-01-01T00:00:00Z'),
      validoAte: new Date('2032-06-01T00:00:00Z'),
    });
    const p = await previa('2032-03', { env: envComCert(vencido, 'base64') });
    expect(p.avisos).toContain('certificado_vencido');
  });
});

// ── Segredos ──────────────────────────────────────────────────────────────

/** Trechos que denunciam vazamento: senha, PFX (inteiro e janelas) e chave privada. */
function segredos(pfx: TestPfx): string[] {
  const b64 = pfx.pfx.toString('base64');
  const janelas = [0, 200, 800, b64.length - 64].map((i) => b64.slice(i, i + 48));
  return [pfx.senha, b64, ...janelas, pfx.chavePrivadaBase64.slice(100, 160)];
}

function semSegredos(texto: string, pfx: TestPfx, onde: string) {
  for (const s of segredos(pfx)) expect(texto.includes(s), `${onde} contém segredo`).toBe(false);
}

describe('segredos do certificado nunca saem da procedure', () => {
  it('sucesso: DTO inteiro sem senha, PFX ou chave privada', async () => {
    await seedBordasDeMarco();
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const p = await previa('2032-03', { env: envComCert(pfx, 'base64') });
    expect(p.dps.status).toBe('gerada');
    semSegredos(JSON.stringify(p), pfx, 'DTO assinado');
    // O certificado PÚBLICO vai no KeyInfo por exigência do XMLDsig; só ele.
    expect(JSON.stringify(p)).toContain(pfx.certificadoBase64);
  });

  it('senha errada: não assina, motivo fixo, nenhuma das senhas aparece', async () => {
    await seedBordasDeMarco();
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const errada = 'senha-errada-0f9e8d7c';
    const p = await previa('2032-03', {
      env: envComCert(pfx, 'base64', { NFSE_CERT_PASSWORD: errada }),
    });
    if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
    expect(p.dps.assinatura).toEqual({ status: 'nao_assinada', motivo: 'certificado_ilegivel' });
    const json = JSON.stringify(p);
    semSegredos(json, pfx, 'DTO senha errada');
    expect(json).not.toContain(errada);
  });

  it('PFX corrompido e caminho inexistente: motivo fixo, sem conteúdo nem senha', async () => {
    await seedBordasDeMarco();
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const corrompido = Buffer.from(pfx.pfx);
    corrompido.fill(0x41, 100, 400);
    const casos: NfseEnv[] = [
      {
        ...BASE_ENV,
        NFSE_CERT_BASE64: corrompido.toString('base64'),
        NFSE_CERT_PASSWORD: pfx.senha,
      },
      {
        ...BASE_ENV,
        NFSE_CERT_PATH: join(tmpdir(), 'nao-existe-nfse', 'cert.pfx'),
        NFSE_CERT_PASSWORD: pfx.senha,
      },
      { ...BASE_ENV, NFSE_CERT_BASE64: '%%%não é base64%%%', NFSE_CERT_PASSWORD: pfx.senha },
    ];
    for (const env of casos) {
      const p = await previa('2032-03', { env });
      if (p.dps.status !== 'gerada') throw new Error(p.dps.status);
      expect(p.dps.assinatura.status).toBe('nao_assinada');
      const json = JSON.stringify(p);
      semSegredos(json, pfx, 'DTO com certificado inválido');
      expect(json).not.toContain(corrompido.toString('base64').slice(0, 48));
    }
  });

  it('erros da procedure não carregam segredo', async () => {
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const env = envComCert(pfx, 'base64');
    for (const p of [
      previa('2099-01', { env }),
      previa('2032-03', { env, auth: 'nao_admin' }),
      previa('2032-03', { env, auth: 'anon' }),
    ]) {
      const e = await erroDe(p);
      const texto = [e.message, e.stack ?? '', inspect(e, { depth: 5 }), JSON.stringify(e)].join(
        '\n',
      );
      semSegredos(texto, pfx, `erro ${e.code}`);
    }
  });

  it('a config carregada não expõe senha nem PFX ao ser serializada ou logada', () => {
    const pfx = gerarPfxDeTeste({ cnpj: CNPJ });
    const config = parseNfseConfig(envComCert(pfx, 'base64'));
    const texto = [
      JSON.stringify(config),
      inspect(config, { depth: 10 }),
      String(config.certificado),
    ].join('\n');
    semSegredos(texto, pfx, 'config');
  });
});
