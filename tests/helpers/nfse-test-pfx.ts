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
}): TestPfx {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = input.validoDe ?? new Date('2030-01-01T00:00:00Z');
  cert.validity.notAfter = input.validoAte ?? new Date('2040-01-01T00:00:00Z');
  const attrs = [{ name: 'commonName', value: `EUNENEM TESTE LTDA:${input.cnpj}` }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Senha aleatória por teste: se ela aparecer em qualquer saída, foi vazamento.
  const senha = `pfx-${randomBytes(12).toString('hex')}`;
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  const pemBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  return {
    pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    senha,
    certificadoBase64: pemBody(forge.pki.certificateToPem(cert)),
    chavePrivadaBase64: pemBody(forge.pki.privateKeyToPem(keys.privateKey)),
    validoAte: cert.validity.notAfter,
  };
}
