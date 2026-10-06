import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { SignedXml } from 'xml-crypto';
import {
  assinarDps,
  carregarCertificado,
} from '../../../apps/eunenem-server/server/nfse/assinatura.js';
import { CertificadoNfse } from '../../../apps/eunenem-server/server/nfse/config.js';
import {
  montarDpsXml,
  numeroDpsPrevia,
  SERIE_DPS_PREVIA,
} from '../../../apps/eunenem-server/server/nfse/dps.js';

/**
 * aperture-dh1k7 — assinatura XMLDsig da DPS com um PFX descartável gerado
 * aqui (RSA 2048, autoassinado). Nenhum certificado real entra no repo.
 */

const SENHA = 'senha-de-teste-descartavel';

function gerarPfx(cn: string): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

let pfx: Buffer;

beforeAll(() => {
  pfx = gerarPfx('EUNENEM TESTE LTDA:11222333000181');
});

function dps() {
  return montarDpsXml({
    tpAmb: '2',
    dhEmi: '2026-10-05T14:30:00-03:00',
    verAplic: 'eunenem-previa-1',
    serie: SERIE_DPS_PREVIA,
    nDPS: numeroDpsPrevia('2026-09'),
    dCompet: '2026-09-01',
    cLocEmi: '2611606',
    prestador: {
      cnpj: '11222333000181',
      inscricaoMunicipal: null,
      opSimpNac: '1',
      regApTribSN: null,
      regEspTrib: '0',
    },
    servico: { cLocPrestacao: '2611606', cTribNac: '100501', xDescServ: 'Comissão', cNBS: null },
    valores: { vServCents: 12345, tribISSQN: '1', tpRetISSQN: '1', pAliq: null },
  });
}

describe('carregarCertificado', () => {
  it('extrai CNPJ do CN (padrão e-CNPJ "RAZAO:CNPJ") e validade', () => {
    const material = carregarCertificado(new CertificadoNfse('base64', () => pfx, SENHA));
    expect(material.cnpj).toBe('11222333000181');
    expect(material.validoAte.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('senha errada → erro de código fixo, sem a senha na mensagem', () => {
    const errado = 'senha-errada-xyz';
    let erro: unknown;
    try {
      carregarCertificado(new CertificadoNfse('base64', () => pfx, errado));
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toBe('nfse_certificado_ilegivel');
    expect(String((erro as Error).stack)).not.toContain(errado);
    expect((erro as Error).cause).toBeUndefined();
  });

  it('bytes que não são PFX → nfse_certificado_ilegivel', () => {
    expect(() =>
      carregarCertificado(new CertificadoNfse('base64', () => Buffer.from('lixo'), SENHA)),
    ).toThrow('nfse_certificado_ilegivel');
  });
});

describe('assinarDps', () => {
  it('Signature é filha de <DPS>, depois de infDPS, referenciando #Id do infDPS', () => {
    const { xml, idDps } = dps();
    const material = carregarCertificado(new CertificadoNfse('base64', () => pfx, SENHA));
    const assinado = assinarDps(xml, idDps, material);

    expect(assinado).toContain(`</infDPS><Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`);
    expect(assinado.endsWith('</Signature></DPS>')).toBe(true);
    expect(assinado).toContain(`<Reference URI="#${idDps}">`);
    expect(assinado).toContain('Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"');
    expect(assinado).toContain('Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"');
    expect(assinado).toContain('<X509Certificate>');
    expect(assinado).not.toContain('PRIVATE KEY');
  });

  it('a assinatura verifica com a chave pública do certificado', () => {
    const { xml, idDps } = dps();
    const material = carregarCertificado(new CertificadoNfse('base64', () => pfx, SENHA));
    const assinado = assinarDps(xml, idDps, material);

    const verificador = new SignedXml({ publicCert: material.certificatePem });
    const assinatura = assinado.slice(assinado.indexOf('<Signature'), assinado.indexOf('</DPS>'));
    verificador.loadSignature(assinatura);
    expect(verificador.checkSignature(assinado)).toBe(true);
  });

  it('adulterar o valor depois de assinar quebra a verificação', () => {
    const { xml, idDps } = dps();
    const material = carregarCertificado(new CertificadoNfse('base64', () => pfx, SENHA));
    const adulterado = assinarDps(xml, idDps, material).replace(
      '<vServ>123.45</vServ>',
      '<vServ>999.99</vServ>',
    );

    const verificador = new SignedXml({ publicCert: material.certificatePem });
    verificador.loadSignature(
      adulterado.slice(adulterado.indexOf('<Signature'), adulterado.indexOf('</DPS>')),
    );
    let valida: boolean;
    try {
      valida = verificador.checkSignature(adulterado);
    } catch {
      valida = false;
    }
    expect(valida).toBe(false);
  });
});
