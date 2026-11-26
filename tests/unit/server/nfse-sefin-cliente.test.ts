import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { carregarCertificado } from '../../../apps/eunenem-server/server/nfse/assinatura.js';
import { CertificadoNfse } from '../../../apps/eunenem-server/server/nfse/config.js';
import {
  criarClienteSefin,
  extrairDadosNfse,
  HOSTS_SEFIN,
} from '../../../apps/eunenem-server/server/nfse/sefin-cliente.js';
import { type FakeSefin, iniciarFakeSefin } from '../../helpers/fake-sefin.js';
import { gerarPfxDeTeste, type TestPfx } from '../../helpers/nfse-test-pfx.js';

/**
 * aperture-wp6j6 — cliente mTLS do Sefin Nacional contra um fake HTTPS que
 * exige certificado de cliente. Nenhum endpoint real é chamado.
 */

const CNPJ = '11222333000181';
/** DPS + cLocEmi(7) + tipo(1) + CNPJ(14) + série(5) + nDPS(15). */
const ID_DPS = `DPS3106200211222333000181${'00001'}${'1'.padStart(15, '0')}`;

/** O helper gera PFX válido a partir de 2030; TLS real confere a validade. */
const VALIDO_AGORA = {
  validoDe: new Date(Date.now() - 86_400_000),
  validoAte: new Date(Date.now() + 365 * 86_400_000),
};

let pfx: TestPfx;
let fake: FakeSefin;

function material() {
  return carregarCertificado(new CertificadoNfse('base64', () => pfx.pfx, pfx.senha));
}

function cliente(timeoutMs = 2_000) {
  return criarClienteSefin({
    hosts: { sefin: `${fake.baseUrl}/SefinNacional`, adn: fake.baseUrl },
    material: material(),
    caPem: fake.caPem,
    timeoutMs,
  });
}

function dpsXml(idDps = ID_DPS) {
  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${idDps}"><tpAmb>2</tpAmb></infDPS></DPS>`;
}

beforeAll(async () => {
  pfx = gerarPfxDeTeste({ cnpj: CNPJ, ...VALIDO_AGORA });
  fake = await iniciarFakeSefin({ clienteCertPem: material().certificatePem });
});

afterAll(async () => {
  await fake.fechar();
});

beforeEach(() => {
  fake.requisicoes.length = 0;
  fake.notas.clear();
  fake.proximaEmissao = [];
  fake.reacaoEvento = 'registrar';
});

describe('hosts por ambiente', () => {
  it('homologação = produção restrita; produção = sefin/adn oficiais', () => {
    expect(HOSTS_SEFIN['2']).toEqual({
      sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
      adn: 'https://adn.producaorestrita.nfse.gov.br',
    });
    expect(HOSTS_SEFIN['1']).toEqual({
      sefin: 'https://sefin.nfse.gov.br/SefinNacional',
      adn: 'https://adn.nfse.gov.br',
    });
  });
});

describe('emitirDps', () => {
  it('envia o XML gzip+base64 em dpsXmlGZipB64, com o certificado de cliente', async () => {
    const r = await cliente().emitirDps(dpsXml());
    expect(r.tipo).toBe('autorizada');
    const req = fake.requisicoes[0];
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/nfse');
    expect(req?.xml).toBe(dpsXml());
    expect(req?.certificadoClienteCn).toBe(`EUNENEM TESTE LTDA:${CNPJ}`);
    if (r.tipo !== 'autorizada') throw new Error('esperava autorizada');
    expect(r.chaveAcesso).toMatch(/^\d{50}$/);
    expect(r.nfseXml).toContain(`<infNFSe Id="NFS${r.chaveAcesso}">`);
  });

  it('400 com erros → rejeitada, com código e descrição', async () => {
    fake.proximaEmissao = [{ rejeitar: { codigo: 'E0312', descricao: 'cTribNac invalido' } }];
    const r = await cliente().emitirDps(dpsXml());
    expect(r).toEqual({
      tipo: 'rejeitada',
      httpStatus: 400,
      erros: [{ codigo: 'E0312', descricao: 'cTribNac invalido', complemento: null }],
    });
  });

  it('conexão derrubada → incerta (pode ter sido registrada)', async () => {
    fake.proximaEmissao = ['registrar_e_derrubar'];
    const r = await cliente().emitirDps(dpsXml());
    expect(r).toMatchObject({ tipo: 'incerta' });
    expect(fake.notas.size).toBe(1);
  });

  it('500 → incerta', async () => {
    fake.proximaEmissao = ['erro_500'];
    expect(await cliente().emitirDps(dpsXml())).toMatchObject({ tipo: 'incerta', httpStatus: 500 });
  });

  it('servidor fora do ar → incerta, sem lançar', async () => {
    const c = criarClienteSefin({
      hosts: { sefin: 'https://127.0.0.1:1/SefinNacional', adn: 'https://127.0.0.1:1' },
      material: material(),
      caPem: fake.caPem,
      timeoutMs: 1_000,
    });
    expect(await c.emitirDps(dpsXml())).toMatchObject({ tipo: 'incerta' });
  });

  it('sem certificado de cliente aceito o servidor recusa o TLS → incerta', async () => {
    const outro = gerarPfxDeTeste({ cnpj: CNPJ, ...VALIDO_AGORA });
    const c = criarClienteSefin({
      hosts: { sefin: `${fake.baseUrl}/SefinNacional`, adn: fake.baseUrl },
      material: carregarCertificado(new CertificadoNfse('base64', () => outro.pfx, outro.senha)),
      caPem: fake.caPem,
      timeoutMs: 1_000,
    });
    expect(await c.emitirDps(dpsXml())).toMatchObject({ tipo: 'incerta' });
    expect(fake.requisicoes).toHaveLength(0);
  });

  it('não confia em servidor fora da cadeia padrão sem caPem explícito', async () => {
    const c = criarClienteSefin({
      hosts: { sefin: `${fake.baseUrl}/SefinNacional`, adn: fake.baseUrl },
      material: material(),
      timeoutMs: 1_000,
    });
    expect(await c.emitirDps(dpsXml())).toMatchObject({ tipo: 'incerta' });
    expect(fake.requisicoes).toHaveLength(0);
  });
});

describe('consultas', () => {
  it('consultarDps: 404 → nao_encontrada; depois de emitida → chave', async () => {
    expect(await cliente().consultarDps(ID_DPS)).toEqual({ tipo: 'nao_encontrada' });
    const emitida = await cliente().emitirDps(dpsXml());
    if (emitida.tipo !== 'autorizada') throw new Error('esperava autorizada');
    expect(await cliente().consultarDps(ID_DPS)).toEqual({
      tipo: 'encontrada',
      chaveAcesso: emitida.chaveAcesso,
    });
  });

  it('consultarNfse devolve o XML descomprimido', async () => {
    const emitida = await cliente().emitirDps(dpsXml());
    if (emitida.tipo !== 'autorizada') throw new Error('esperava autorizada');
    const r = await cliente().consultarNfse(emitida.chaveAcesso);
    expect(r).toEqual({ tipo: 'encontrada', nfseXml: emitida.nfseXml });
    expect(await cliente().consultarNfse('9'.repeat(50))).toEqual({ tipo: 'nao_encontrada' });
  });
});

describe('eventos', () => {
  it('registrarEvento envia pedidoRegistroEventoXmlGZipB64 e consultarEvento o recupera', async () => {
    const emitida = await cliente().emitirDps(dpsXml());
    if (emitida.tipo !== 'autorizada') throw new Error('esperava autorizada');
    const chave = emitida.chaveAcesso;
    expect(await cliente().consultarEvento(chave, '101101', 1)).toEqual({ tipo: 'nao_encontrado' });
    const pedido = '<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"/>';
    const r = await cliente().registrarEvento(chave, pedido);
    expect(r.tipo).toBe('registrado');
    expect(fake.requisicoes.at(-1)).toMatchObject({
      method: 'POST',
      path: `/nfse/${chave}/eventos`,
      xml: pedido,
    });
    const consultado = await cliente().consultarEvento(chave, '101101', 1);
    expect(consultado.tipo).toBe('encontrado');
    expect(fake.requisicoes.at(-1)?.path).toBe(`/nfse/${chave}/eventos/101101/1`);
  });

  it('evento recusado → rejeitado com erros', async () => {
    const emitida = await cliente().emitirDps(dpsXml());
    if (emitida.tipo !== 'autorizada') throw new Error('esperava autorizada');
    fake.reacaoEvento = {
      rejeitar: { codigo: 'E0830', descricao: 'prazo de cancelamento expirado' },
    };
    expect(await cliente().registrarEvento(emitida.chaveAcesso, '<x/>')).toMatchObject({
      tipo: 'rejeitado',
      erros: [{ codigo: 'E0830' }],
    });
  });
});

describe('extrairDadosNfse', () => {
  it('lê chave (Id NFS…) e nNFSe do XML devolvido', () => {
    const chave = '1'.repeat(50);
    expect(
      extrairDadosNfse(`<NFSe><infNFSe Id="NFS${chave}"><nNFSe>42</nNFSe></infNFSe></NFSe>`),
    ).toEqual({
      chaveAcesso: chave,
      numero: '42',
    });
    expect(extrairDadosNfse('<NFSe/>')).toEqual({ chaveAcesso: null, numero: null });
  });
});
