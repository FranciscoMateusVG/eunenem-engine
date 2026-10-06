import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import type { CertificadoNfse } from './config.js';

/**
 * Assinatura XMLDsig da DPS com o e-CNPJ A1 (aperture-dh1k7). Porta
 * nfse-sandbox/src/pfx.ts + signing.ts.
 *
 * Perfil SN NFS-e: rsa-sha256, digest sha256, exc-c14n, transforms
 * enveloped + exc-c14n, KeyInfo/X509Data com o certificado. A Reference
 * aponta para `#<Id do infDPS>` e a `<Signature>` entra como irmã DEPOIS de
 * `infDPS`, dentro de `<DPS>` (TCDPS = infDPS + ds:Signature).
 *
 * SEGREDOS: a chave privada só existe em `MaterialCertificado`, que nunca sai
 * deste processo. Toda falha de leitura vira `nfse_certificado_ilegivel` sem
 * `cause` (a mensagem do node-forge pode citar o conteúdo).
 */

export interface MaterialCertificado {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** CNPJ do CN "RAZAO SOCIAL:CNPJ" do e-CNPJ, se houver. */
  readonly cnpj: string | null;
  readonly validoAte: Date;
}

const PKCS8_KEY_BAG = forge.pki.oids.pkcs8ShroudedKeyBag as string;
const KEY_BAG = forge.pki.oids.keyBag as string;
const CERT_BAG = forge.pki.oids.certBag as string;

class CertificadoIlegivelError extends Error {
  constructor() {
    super('nfse_certificado_ilegivel');
    this.name = 'CertificadoIlegivelError';
  }
}

export function carregarCertificado(certificado: CertificadoNfse): MaterialCertificado {
  try {
    const der = certificado.lerPfx().toString('binary');
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, certificado.senha());

    const key =
      p12.getBags({ bagType: PKCS8_KEY_BAG })[PKCS8_KEY_BAG]?.[0]?.key ??
      p12.getBags({ bagType: KEY_BAG })[KEY_BAG]?.[0]?.key;
    const cert = p12.getBags({ bagType: CERT_BAG })[CERT_BAG]?.[0]?.cert;
    if (!key || !cert) throw new CertificadoIlegivelError();

    const cn = cert.subject.getField('CN')?.value;
    const cnpj = typeof cn === 'string' ? (/(\d{14})/.exec(cn)?.[1] ?? null) : null;

    return {
      privateKeyPem: forge.pki.privateKeyToPem(key),
      certificatePem: forge.pki.certificateToPem(cert),
      cnpj,
      validoAte: cert.validity.notAfter,
    };
  } catch {
    throw new CertificadoIlegivelError();
  }
}

export function assinarDps(xml: string, idDps: string, material: MaterialCertificado): string {
  const certBase64 = material.certificatePem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s/g, '');

  const sig = new SignedXml({
    privateKey: material.privateKeyPem,
    publicCert: material.certificatePem,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`;
  sig.addReference({
    xpath: `//*[local-name()='infDPS' and @Id='${idDps}']`,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  sig.computeSignature(xml, {
    location: { reference: "/*[local-name()='DPS']", action: 'append' },
  });
  return sig.getSignedXml();
}
