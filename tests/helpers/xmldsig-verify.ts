import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * Verificador XMLDsig da DPS que NÃO usa o xml-crypto (a lib que assina).
 * A canonicalização exclusiva é do libxml2 (`xmllint --exc-c14n`), e o
 * hash e o RSA são do OpenSSL via node:crypto. Assim um bug da lib de
 * assinatura não se esconde atrás da mesma lib conferindo a si mesma.
 *
 * Perfil esperado (SN NFS-e, como no nfse-sandbox): exc-c14n, rsa-sha256,
 * digest sha256, transforms enveloped + exc-c14n, Reference "#<Id do
 * infDPS>", Signature como irmã depois de infDPS dentro de DPS.
 */

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
const NFSE = 'http://www.sped.fazenda.gov.br/nfse';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

export interface DsigCheck {
  readonly idReferenciado: string;
  readonly certificadoBase64: string;
  readonly digestConfere: boolean;
  readonly assinaturaConfere: boolean;
  readonly algoritmos: {
    readonly c14n: string;
    readonly assinatura: string;
    readonly digest: string;
    readonly transforms: readonly string[];
  };
}

function one(xml: string, re: RegExp, what: string): RegExpExecArray {
  const all = [...xml.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))];
  if (all.length !== 1) throw new Error(`esperava exatamente 1 ${what}, achei ${all.length}`);
  return all[0] as RegExpExecArray;
}

/** Fragmento → documento próprio com o namespace herdado declarado. */
function standalone(fragment: string, tag: string, ns: string): string {
  const open = new RegExp(`^<${tag}(\\s|>)`);
  if (!open.test(fragment)) throw new Error(`fragmento não começa em <${tag}>`);
  if (/^<[^>]*\sxmlns="/.test(fragment)) return fragment;
  return fragment.replace(open, `<${tag} xmlns="${ns}"$1`);
}

function excC14n(xml: string): Buffer {
  const run = spawnSync('xmllint', ['--nonet', '--exc-c14n', '-'], { input: xml });
  if (run.status !== 0) throw new Error(`xmllint --exc-c14n falhou: ${run.stderr.toString()}`);
  return run.stdout;
}

export function verificarAssinaturaDps(signedXml: string): DsigCheck {
  // Estrutura TCDPS: <DPS> infDPS, depois Signature, e nada mais.
  const dps = one(
    signedXml,
    /<DPS\b[^>]*>(<infDPS\b[\s\S]*?<\/infDPS>)(<Signature\b[\s\S]*<\/Signature>)<\/DPS>/,
    'DPS com infDPS seguido de Signature',
  );
  const infDps = dps[1] as string;
  const signature = dps[2] as string;
  if (!signature.startsWith(`<Signature xmlns="${DSIG}"`)) {
    throw new Error('Signature fora do namespace xmldsig');
  }

  const signedInfo = one(signature, /<SignedInfo\b[\s\S]*?<\/SignedInfo>/, 'SignedInfo')[0];
  const attr = (re: RegExp, what: string) => one(signedInfo, re, what)[1] as string;
  const c14n = attr(/<CanonicalizationMethod Algorithm="([^"]+)"/, 'CanonicalizationMethod');
  const assinatura = attr(/<SignatureMethod Algorithm="([^"]+)"/, 'SignatureMethod');
  const digest = attr(/<DigestMethod Algorithm="([^"]+)"/, 'DigestMethod');
  const uri = attr(/<Reference URI="#([^"]+)"/, 'Reference');
  const transforms = [...signedInfo.matchAll(/<Transform Algorithm="([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
  const digestValue = attr(/<DigestValue>([^<]+)<\/DigestValue>/, 'DigestValue');
  const signatureValue = one(
    signature,
    /<SignatureValue>([^<]+)<\/SignatureValue>/,
    'SignatureValue',
  )[1] as string;
  const certificadoBase64 = (
    one(signature, /<X509Certificate>([^<]+)<\/X509Certificate>/, 'X509Certificate')[1] as string
  ).replace(/\s/g, '');

  const infId = one(infDps, /^<infDPS Id="([^"]+)"/, 'infDPS@Id')[1] as string;
  if (uri !== infId) throw new Error(`Reference aponta para #${uri}, infDPS tem Id ${infId}`);
  if (c14n !== EXC_C14N) throw new Error(`c14n inesperada: ${c14n}`);

  // O enveloped-signature não remove nada: a Signature não está dentro do infDPS.
  const digestCalc = createHash('sha256')
    .update(excC14n(standalone(infDps, 'infDPS', NFSE)))
    .digest('base64');

  const certPem = `-----BEGIN CERTIFICATE-----\n${certificadoBase64}\n-----END CERTIFICATE-----\n`;
  const assinaturaConfere = verify(
    'sha256',
    excC14n(standalone(signedInfo, 'SignedInfo', DSIG)),
    createPublicKey(certPem),
    Buffer.from(signatureValue.replace(/\s/g, ''), 'base64'),
  );

  return {
    idReferenciado: uri,
    certificadoBase64,
    digestConfere: digestCalc === digestValue.trim(),
    assinaturaConfere,
    algoritmos: { c14n, assinatura, digest, transforms },
  };
}
