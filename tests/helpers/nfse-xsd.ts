import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Validação da DPS contra o XSD oficial da NFS-e (pack v1.01, 2026-02-09),
 * usando o `xmllint` (libxml2), um validador XSD completo e independente do
 * código que gera o XML. Biblioteca JS de XSD completa não existe sem
 * binding nativo; o binário do sistema é a fronteira real mais simples.
 *
 * Única normalização: o pack oficial declara TSSerieDPS com o pattern
 * `^0{0,4}\d{1,5}$`. Em regex XSD, `^` e `$` são caracteres literais
 * (patterns já são ancorados), então o libxml2 recusa qualquer série. A
 * intenção é `0{0,4}\d{1,5}`. Os arquivos em tests/fixtures/nfse-xsd/v1.01
 * ficam verbatim; a cópia derivada vive num diretório temporário. O teste
 * do harness prova que o pattern verbatim recusa uma série válida.
 */

const XSD_DIR = fileURLToPath(new URL('../fixtures/nfse-xsd/v1.01/', import.meta.url));
const SERIE_PATTERN_OFICIAL = '<xs:pattern value="^0{0,4}\\d{1,5}$"/>';
const SERIE_PATTERN_NORMALIZADO = '<xs:pattern value="0{0,4}\\d{1,5}"/>';

export const DPS_XSD_OFICIAL = join(XSD_DIR, 'DPS_v1.01.xsd');

let normalizedDir: string | undefined;

/** Diretório com o pack 1.01 e apenas o pattern de TSSerieDPS normalizado. */
export function dpsXsdNormalizado(): string {
  if (normalizedDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'nfse-xsd-'));
    for (const file of readdirSync(XSD_DIR)) {
      if (file.endsWith('.xsd')) copyFileSync(join(XSD_DIR, file), join(dir, file));
    }
    const simples = join(dir, 'tiposSimples_v1.01.xsd');
    const original = readFileSync(simples, 'utf8');
    if (!original.includes(SERIE_PATTERN_OFICIAL)) {
      throw new Error('pattern de TSSerieDPS mudou no pack; revise a normalização do harness');
    }
    writeFileSync(simples, original.replace(SERIE_PATTERN_OFICIAL, SERIE_PATTERN_NORMALIZADO));
    normalizedDir = dir;
  }
  return join(normalizedDir, 'DPS_v1.01.xsd');
}

export interface XsdResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function assertXmllint(): void {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('xmllint (libxml2) não encontrado no PATH; a validação XSD não roda sem ele');
  }
}

export function validateAgainstXsd(xml: string, xsdPath: string): XsdResult {
  assertXmllint();
  const run = spawnSync('xmllint', ['--noout', '--nonet', '--schema', xsdPath, '-'], {
    input: xml,
    encoding: 'utf8',
  });
  const errors = run.stderr
    .split('\n')
    .filter((line) => line.includes('validity error') || line.includes('parser error'));
  return { ok: run.status === 0, errors };
}

/** Valida contra o pack oficial 1.01 (com a normalização documentada acima). */
export function validateDps(xml: string): XsdResult {
  return validateAgainstXsd(xml, dpsXsdNormalizado());
}
