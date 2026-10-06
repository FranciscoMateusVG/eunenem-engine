import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DPS_XSD_OFICIAL, validateAgainstXsd, validateDps } from '../../helpers/nfse-xsd.js';

/**
 * O harness XSD precisa provar que aceita uma DPS conforme e recusa uma
 * não conforme, senão um "ok" dele não diz nada sobre a prévia.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/nfse-dps/${name}`, import.meta.url), 'utf8');

describe('harness XSD da DPS (pack oficial v1.01)', () => {
  it('aceita a DPS mínima conforme', () => {
    expect(validateDps(fixture('dps-minima-valida.xml'))).toEqual({ ok: true, errors: [] });
  });

  it('recusa o shape do builder antigo do nfse-sandbox', () => {
    const r = validateDps(fixture('dps-sandbox-antiga.xml'));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/cTribNac/);
  });

  it('recusa Id com "_" (TSIdDPS é DPS + 42 dígitos)', () => {
    const xml = fixture('dps-minima-valida.xml').replace('Id="DPS', 'Id="DPS_');
    expect(validateDps(xml).ok).toBe(false);
  });

  it('recusa DPS sem totTrib', () => {
    const xml = fixture('dps-minima-valida.xml').replace(
      '<totTrib><indTotTrib>0</indTotTrib></totTrib>',
      '',
    );
    expect(validateDps(xml).ok).toBe(false);
  });

  it('o pattern verbatim de TSSerieDPS recusa série válida; só ele é normalizado', () => {
    const r = validateAgainstXsd(fixture('dps-minima-valida.xml'), DPS_XSD_OFICIAL);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/serie.*\^0\{0,4\}/);
  });
});
