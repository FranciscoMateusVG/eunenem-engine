import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarLegacyUsersSeed } from '../../apps/eunenem-server/lib/legacy-users.js';

/**
 * aperture-op09b / 791lz — the legacy-user snapshot loader. The REAL customer
 * list can't be committed (public deploy mirror), so it's mounted at runtime
 * OUTSIDE the git tree and its path passed via LEGACY_USERS_PATH. This is the
 * code half of the ses0u PII gate (Cipher). Pins:
 *   - LEGACY_USERS_PATH set + valid file → reads THAT file.
 *   - unset / empty env → the committed 1-email stub (fail-safe, no crash).
 *   - env set + malformed / missing file → THROWS (fail-loud at boot).
 *   - same Zod shape validation both ways; loader never logs the list.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'op09b-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, contents: string): string {
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe('carregarLegacyUsersSeed (aperture-op09b)', () => {
  it('unset env → the committed stub (operator email only)', () => {
    const seed = carregarLegacyUsersSeed({});
    expect(seed).toHaveLength(1);
    expect(seed[0]?.email).toBe('franciscomateusvg@gmail.com');
  });

  it('empty-string env → the committed stub (no crash; empty ≠ a real path)', () => {
    const seed = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: '' });
    expect(seed[0]?.email).toBe('franciscomateusvg@gmail.com');
    expect(carregarLegacyUsersSeed({ LEGACY_USERS_PATH: '   ' })).toHaveLength(1);
  });

  it('⭐ env set + valid file → reads THAT file, not the stub', () => {
    const path = writeJson(
      'real.json',
      JSON.stringify([
        { email: 'a@real.com', nome: 'Lista A', utm: 'a1', mimos: 3 },
        { email: 'b@real.com' },
      ]),
    );
    const seed = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });
    expect(seed).toHaveLength(2);
    expect(seed.map((e) => e.email)).toEqual(['a@real.com', 'b@real.com']);
    // optional-field defaults still apply through the same schema.
    expect(seed[1]).toMatchObject({ email: 'b@real.com', utm: null, nome: null, mimos: null });
  });

  it('⭐ env set + MALFORMED json → throws SANITIZED (no PII fragment, no file contents in the error)', () => {
    // Malformed JSON carrying a PII-looking fragment near the syntax error —
    // a raw JSON.parse SyntaxError can embed a snippet of exactly this region.
    const path = writeJson('bad.json', '[{ "email": "secret-victim@leak.example" oops }]');
    let caught: Error | undefined;
    try {
      carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'must fail loud').toBeDefined();
    expect(
      caught?.message,
      'sanitized error must NOT echo file contents / a PII fragment',
    ).not.toContain('secret-victim');
    expect(caught?.message, 'error surfaces the path for ops').toContain(path);
  });

  it('⭐ env set + SHAPE-drifted file (valid json, wrong shape) → throws (Zod, path-not-value)', () => {
    const path = writeJson('drift.json', JSON.stringify([{ email: '' }])); // empty email rejected
    expect(() => carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path })).toThrow();
  });

  it('⭐ env set + MISSING file → throws SANITIZED with the ENOENT code (fail-loud; a set path must be readable)', () => {
    const missing = join(dir, 'does-not-exist.json');
    let caught: Error | undefined;
    try {
      carregarLegacyUsersSeed({ LEGACY_USERS_PATH: missing });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message, 'ops-clear error code surfaced').toContain('ENOENT');
  });
});
