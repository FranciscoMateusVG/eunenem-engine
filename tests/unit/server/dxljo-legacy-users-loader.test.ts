/**
 * aperture-dxljo — loader-matrix GAP coverage for the LEGACY_USERS_PATH
 * out-of-repo read path (PR #329 / aperture-791lz, lib/legacy-users.ts).
 *
 * SPLIT vs tests/unit/op09b-legacy-users-loader.test.ts (READ IT FIRST — do
 * not duplicate): op09b already pins
 *   - unset / empty / whitespace-only env → the committed stub,
 *   - env + valid file → reads THAT file (incl. optional-field null-defaults),
 *   - env + MALFORMED json → throws SANITIZED (no PII fragment, path present),
 *   - env + shape-drifted file (empty email) → throws (Zod),
 *   - env + MISSING file → throws sanitized with ENOENT.
 * THIS file covers only the gaps:
 *   (1) UNREADABLE path (directory-instead-of-file; chmod-000 variant),
 *   (2) env-path entries flowing through buscarCampanhasLegado end-to-end
 *       (and the stub NOT bleeding through when the env path is set),
 *   (3) shape-validation PARITY: identical content via env path vs the
 *       committed stub parses to identical entries (same null-defaults),
 *   (4) SYMMETRY of the fail-loud posture: an invalid-shape committed stub
 *       boot-throws at module evaluation exactly like an invalid env file
 *       (no fallback asymmetry in EITHER direction),
 *   (5) load TIMING: LEGACY_USERS_SEED is resolved ONCE at module eval —
 *       flipping process.env afterwards does not re-read; tests must use the
 *       injectable `env` seam of carregarLegacyUsersSeed.
 *
 * NOTE on the fail-loud reality (matches the implementation, NOT a
 * fallback-to-stub design): when LEGACY_USERS_PATH is set, a missing /
 * unreadable / malformed / shape-drifted file THROWS (sanitized: path + fs
 * code or PARSE_ERROR, never file contents) so the server crashes at boot
 * rather than silently serving the stub or an empty list.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buscarCampanhasLegado,
  carregarLegacyUsersSeed,
  LEGACY_USERS_SEED,
  NOME_FALLBACK_LEGADO,
} from '../../../apps/eunenem-server/lib/legacy-users.js';

const STUB_EMAIL = 'franciscomateusvg@gmail.com';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dxljo-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.doUnmock('../../../apps/eunenem-server/lib/seed-data/legacy-1.0-users.json');
  vi.resetModules();
});

function writeJson(name: string, contents: string): string {
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe('carregarLegacyUsersSeed — unreadable path (aperture-dxljo)', () => {
  it('env set to a DIRECTORY (portable "unreadable" case) → throws SANITIZED, path + code only', () => {
    const dirPath = join(dir, 'i-am-a-directory');
    mkdirSync(dirPath);
    let caught: Error | undefined;
    try {
      carregarLegacyUsersSeed({ LEGACY_USERS_PATH: dirPath });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, 'unreadable path must fail loud, not fall back').toBeDefined();
    // Sanitized shape: "legacy-users: failed to load <path> (<code>)".
    expect(caught?.message).toContain(dirPath);
    expect(caught?.message).toContain('EISDIR');
  });

  // chmod 000 does NOT block root (root reads anything) — skip under uid 0
  // (e.g. a rootful CI container) rather than fail; the directory case above
  // is the portable unreadable pin.
  it.skipIf(process.getuid?.() === 0)(
    'env set to a chmod-000 file → throws SANITIZED with EACCES, no fallback',
    () => {
      const p = writeJson('locked.json', JSON.stringify([{ email: 'locked@x.com' }]));
      chmodSync(p, 0o000);
      try {
        let caught: Error | undefined;
        try {
          carregarLegacyUsersSeed({ LEGACY_USERS_PATH: p });
        } catch (e) {
          caught = e as Error;
        }
        expect(caught, 'permission-denied must fail loud').toBeDefined();
        expect(caught?.message).toContain('EACCES');
        expect(caught?.message).toContain(p);
        // Sanitized: the file's contents (a PII-shaped email) never surface.
        expect(caught?.message).not.toContain('locked@x.com');
      } finally {
        chmodSync(p, 0o600); // let afterEach rmSync succeed
      }
    },
  );
});

describe('env-path entries flow through buscarCampanhasLegado (aperture-dxljo)', () => {
  it('an email UNIQUE to the mounted file surfaces as a legado DTO; the stub does NOT bleed through', () => {
    const unique = `dxljo-unique-${Date.now()}@mounted.example`;
    const path = writeJson(
      'mounted.json',
      JSON.stringify([{ email: unique, nome: 'Lista Montada', utm: 'montada', mimos: 5 }]),
    );
    const seed = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });

    // The loaded list is exclusively the env file — the stub is NOT merged in.
    expect(seed.map((e) => e.email)).toEqual([unique]);
    expect(buscarCampanhasLegado(STUB_EMAIL, seed)).toEqual([]);

    // …and the matcher resolves the mounted entry end-to-end (case-insensitive).
    const out = buscarCampanhasLegado(unique.toUpperCase(), seed);
    expect(out).toEqual([{ email: unique, nome: 'Lista Montada', utm: 'montada', mimos: 5 }]);
  });

  it('mounted entry with utm/nome/mimos omitted gets the same null-defaults + nome fallback as the stub', () => {
    const path = writeJson('bare.json', JSON.stringify([{ email: 'bare@mounted.example' }]));
    const seed = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });
    const [dto] = buscarCampanhasLegado('bare@mounted.example', seed);
    expect(dto).toEqual({
      email: 'bare@mounted.example',
      nome: NOME_FALLBACK_LEGADO,
      utm: null,
      mimos: null,
    });
  });
});

describe('shape validation is IDENTICAL for both sources (aperture-dxljo)', () => {
  it('the committed stub content, mounted via env path, parses to IDENTICAL entries', () => {
    // Mirror the stub's raw bytes into a temp file — both branches must run
    // the same Zod schema and produce the same parsed rows.
    const stubRaw = readFileSync(
      new URL('../../../apps/eunenem-server/lib/seed-data/legacy-1.0-users.json', import.meta.url),
      'utf8',
    );
    const path = writeJson('mirror.json', stubRaw);
    const viaEnv = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });
    const viaStub = carregarLegacyUsersSeed({});
    expect(viaEnv).toEqual(viaStub);
  });

  it('optional-field defaulting is the same schema on both branches (utm/nome/mimos → null)', () => {
    // Env-path side: a row with the optional fields OMITTED gets the Zod
    // defaults (op09b pins this too; here it anchors the parity claim).
    const path = writeJson('defaults.json', JSON.stringify([{ email: STUB_EMAIL }]));
    const [viaEnv] = carregarLegacyUsersSeed({ LEGACY_USERS_PATH: path });
    expect(viaEnv).toEqual({ email: STUB_EMAIL, utm: null, nome: null, mimos: null });
  });

  it('SYMMETRY: an invalid-shape committed stub boot-throws at module eval (no env-only strictness)', async () => {
    // op09b pins the env-path side (shape-drifted file → throw). This pins the
    // STUB side: mock the committed JSON with an invalid row and re-evaluate
    // the module — the module-level LEGACY_USERS_SEED parse must reject the
    // import itself (boot crash), NOT fall back or serve a partial list.
    vi.stubEnv('LEGACY_USERS_PATH', ''); // force the stub branch during re-eval
    vi.doMock('../../../apps/eunenem-server/lib/seed-data/legacy-1.0-users.json', () => ({
      default: [{ utm: 'row-without-email' }],
    }));
    vi.resetModules();
    await expect(import('../../../apps/eunenem-server/lib/legacy-users.js')).rejects.toThrow();
  });
});

describe('load timing — module-eval snapshot, injectable env seam (aperture-dxljo)', () => {
  it('LEGACY_USERS_SEED is resolved ONCE at import: flipping process.env later does NOT re-read', () => {
    const path = writeJson('late.json', JSON.stringify([{ email: 'too-late@mounted.example' }]));
    vi.stubEnv('LEGACY_USERS_PATH', path);
    // The statically-imported snapshot was built with the env at import time
    // (unset in the vitest process) → still the stub, not the late file.
    expect(LEGACY_USERS_SEED).toHaveLength(1);
    expect(LEGACY_USERS_SEED[0]?.email).toBe(STUB_EMAIL);
    // The seam is how tests (and this suite) inject env — same call, new env.
    expect(carregarLegacyUsersSeed(process.env).map((e) => e.email)).toEqual([
      'too-late@mounted.example',
    ]);
  });
});
