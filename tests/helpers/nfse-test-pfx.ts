import { randomBytes } from 'node:crypto';
import forge from 'node-forge';

/**
 * e-CNPJ A1 de teste: PFX autoassinado gerado em tempo de teste. Nenhum
 * certificado real entra no repositório nem é lido do disco do operador.
 * O CN segue o padrão do e-CNPJ ("RAZAO SOCIAL:CNPJ").
 */
export interface TestPfx {
  readonly pfx: Buffer;
  readonly senha: string;
  /** Certificado público em DER base64 (o que vai em X509Certificate). */
  readonly certificadoBase64: string;
  /** Corpo base64 da chave privada (PKCS#1) para procurar vazamento. */
  readonly chavePrivadaBase64: string;
  readonly validoAte: Date;
}

export function gerarPfxDeTeste(input: {
  readonly cnpj: string;
  readonly validoDe?: Date;
  readonly validoAte?: Date;
  /**
   * Inclui a AC emissora no PFX, como os e-CNPJ reais (folha + cadeia).
   * 'ac_primeiro' põe o certificado da AC antes do da folha.
   */
  readonly cadeia?: 'folha_primeiro' | 'ac_primeiro';
  readonly senha?: string;
}): TestPfx {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = input.validoDe ?? new Date('2030-01-01T00:00:00Z');
  cert.validity.notAfter = input.validoAte ?? new Date('2040-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: `EUNENEM TESTE LTDA:${input.cnpj}` }];
  cert.setSubject(attrs);

  const certs: forge.pki.Certificate[] = [cert];
  if (input.cadeia === undefined) {
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
  } else {
    // AC sintética; o CN dela também tem 14 dígitos, como "AC ... v5" + CNPJ da AC.
    const acKeys = forge.pki.rsa.generateKeyPair(2048);
    const ac = forge.pki.createCertificate();
    ac.publicKey = acKeys.publicKey;
    ac.serialNumber = `02${randomBytes(8).toString('hex')}`;
    ac.validity.notBefore = new Date('2029-01-01T00:00:00Z');
    ac.validity.notAfter = new Date('2045-01-01T00:00:00Z');
    const acAttrs = [{ name: 'commonName', value: 'AC TESTE RFB:99888777000110' }];
    ac.setSubject(acAttrs);
    ac.setIssuer(acAttrs);
    ac.setExtensions([{ name: 'basicConstraints', cA: true }]);
    ac.sign(acKeys.privateKey, forge.md.sha256.create());
    cert.setIssuer(acAttrs);
    cert.sign(acKeys.privateKey, forge.md.sha256.create());
    if (input.cadeia === 'ac_primeiro') certs.unshift(ac);
    else certs.push(ac);
  }

  // Senha aleatória por teste: se ela aparecer em qualquer saída, foi vazamento.
  const senha = input.senha ?? `pfx-${randomBytes(12).toString('hex')}`;
  // Com cadeia, sem localKeyId: o forge o grudaria no primeiro cert (a AC, se
  // vier primeiro). Sem atributos, o par chave/cert só se acha pela chave pública.
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, certs, senha, {
    algorithm: '3des',
    ...(input.cadeia === undefined ? {} : { generateLocalKeyId: false }),
  });
  const pemBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    senha,
    certificadoBase64: pemBody(forge.pki.certificateToPem(cert)),
    chavePrivadaBase64: pemBody(forge.pki.privateKeyToPem(keys.privateKey)),
    validoAte: cert.validity.notAfter,
  };
}
