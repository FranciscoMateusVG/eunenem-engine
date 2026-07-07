// aperture-8jcec — ADVERSARIAL extension suite for the legacy-1.0-users reader.
//
// Rex's baseline suite (tests/unit/mebax-legacy-users.test.ts, aperture-mebax)
// covers the happy contract: present -> match, absent -> empty, basic
// case-insensitivity, optional-field fallbacks. Per the agreed split, THIS file
// covers only the adversarial edges — the inputs a real 6-month legacy export
// will eventually throw at us (spec §10: the export drops into the same JSON
// path with NO code change, so the reader must already survive hostile rows).
//
// Contract under test (declared by Rex on aperture-7hm2g, 2026-07-07):
//   buscarCampanhasLegado(email, entries = LEGACY_USERS_SEED)
//     -> readonly { email; nome: string; utm: string|null; mimos: number|null }[]
//   - PURE; injectable entries (no fs/JSON mocking needed)
//   - matching = trim + toLowerCase() on BOTH sides (default Unicode lowering)
//   - multiple entries with the same email ALL return
//   - nome fallback is SERVER-side: 'Minha lista (EuNeném 1.0)', never null
//   - utm / mimos are null-passthrough
//   - LegacyUserEntrySchema (zod) validates at module load, throws boot-loud

import { describe, expect, it } from 'vitest';
import {
  buscarCampanhasLegado,
  LEGACY_USERS_SEED,
  type LegacyUserEntry,
  LegacyUserEntrySchema,
} from '../../apps/eunenem-server/lib/legacy-users.js';

const NOME_FALLBACK = 'Minha lista (EuNeném 1.0)';

const entry = (overrides: Partial<LegacyUserEntry> & { email: string }): LegacyUserEntry =>
  LegacyUserEntrySchema.parse(overrides);

// Schema-BYPASSING constructor for hostile rows the belt (schema) would reject
// at parse time. buscarCampanhasLegado's runtime guards (the suspenders) must
// hold even for entries injected past validation — belt and suspenders are
// SEPARATE layers and each gets its own tests.
const hostileEntry = (overrides: Partial<LegacyUserEntry> & { email: string }): LegacyUserEntry =>
  ({ utm: null, nome: null, mimos: null, ...overrides }) as LegacyUserEntry;

describe('buscarCampanhasLegado — adversarial edges (aperture-8jcec)', () => {
  describe('multiplicity', () => {
    it('returns ALL entries sharing the same email, preserving JSON order', () => {
      const entries = [
        entry({ email: 'multi@ex.com', nome: 'Lista A' }),
        entry({ email: 'outra@ex.com', nome: 'Não sou eu' }),
        entry({ email: 'multi@ex.com', nome: 'Lista B' }),
      ];
      const result = buscarCampanhasLegado('multi@ex.com', entries);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.nome)).toEqual(['Lista A', 'Lista B']);
    });

    it('returns duplicate identical rows twice (reader does NOT dedup — export hygiene is upstream)', () => {
      const dup = entry({ email: 'dup@ex.com', nome: 'Mesma lista' });
      const result = buscarCampanhasLegado('dup@ex.com', [dup, dup]);
      expect(result).toHaveLength(2);
    });
  });

  describe('whitespace semantics (trim ends, NEVER normalize interior)', () => {
    it('matches when the ENTRY email carries surrounding whitespace', () => {
      const entries = [entry({ email: '  padded@ex.com  ' })];
      expect(buscarCampanhasLegado('padded@ex.com', entries)).toHaveLength(1);
    });

    it('matches when the QUERY email carries surrounding whitespace (incl. tab/newline)', () => {
      const entries = [entry({ email: 'padded@ex.com' })];
      expect(buscarCampanhasLegado('\t padded@ex.com \n', entries)).toHaveLength(1);
    });

    it('does NOT match when whitespace is INTERIOR — trim must not become "remove all spaces"', () => {
      const entries = [entry({ email: 'fran cisco@ex.com' })];
      expect(buscarCampanhasLegado('francisco@ex.com', entries)).toHaveLength(0);
    });

    it('empty-string query returns [] even if a whitespace-only entry email exists (suspenders)', () => {
      // Rex implemented BOTH layers (2026-07-07): the schema kills ' ' emails
      // at module load (belt — pinned in the schema describe below), and the
      // matcher short-circuits an empty-after-trim query (suspenders — tested
      // HERE with a schema-BYPASSED hostile entry). One malformed export row
      // must never match every anonymous-ish caller.
      const entries = [hostileEntry({ email: ' ' })];
      expect(buscarCampanhasLegado('', entries)).toHaveLength(0);
      expect(buscarCampanhasLegado('   ', entries)).toHaveLength(0);
    });
  });

  describe('unicode case-folding (default toLowerCase, no locale arg — deterministic)', () => {
    it('folds plain ASCII mixed-case both directions', () => {
      const entries = [entry({ email: 'MiXeD@Ex.COM' })];
      expect(buscarCampanhasLegado('mixed@ex.com', entries)).toHaveLength(1);
      expect(buscarCampanhasLegado('MIXED@EX.COM', entries)).toHaveLength(1);
    });

    it('Turkish dotted İ (U+0130) does NOT fold to ASCII i — documented standard-fold behavior', () => {
      // 'İ'.toLowerCase() === 'i̇' (i + combining dot above), which !== 'i'.
      // Rex declared we accept standard Unicode lowering; this test PINS that
      // decision so a future "fix" to locale-aware folding fails loudly here
      // and forces a deliberate contract re-negotiation.
      const entries = [entry({ email: 'İzzy@ex.com' })];
      expect(buscarCampanhasLegado('izzy@ex.com', entries)).toHaveLength(0);
      // …but the same İ on both sides is self-consistent:
      expect(buscarCampanhasLegado('İzzy@ex.com', entries)).toHaveLength(1);
    });
  });

  describe('nome fallback (server-side, never null)', () => {
    it('applies the exact fallback label when nome is null', () => {
      const entries = [entry({ email: 'semnome@ex.com', nome: null })];
      expect(buscarCampanhasLegado('semnome@ex.com', entries)[0]?.nome).toBe(NOME_FALLBACK);
    });

    it('applies the fallback when nome is blank ("" or whitespace-only) — schema-bypassed (suspenders)', () => {
      // The schema rejects nome:'' at parse time (belt — pinned below); the
      // matcher's trim-aware fallback predicate additionally covers blank
      // nomes on schema-bypassed entries. An empty card title never renders.
      const empty = [hostileEntry({ email: 'vazio@ex.com', nome: '' })];
      expect(buscarCampanhasLegado('vazio@ex.com', empty)[0]?.nome).toBe(NOME_FALLBACK);
      const blank = [hostileEntry({ email: 'branco@ex.com', nome: '   ' })];
      expect(buscarCampanhasLegado('branco@ex.com', blank)[0]?.nome).toBe(NOME_FALLBACK);
    });
  });

  describe('null-passthrough fields', () => {
    it('passes utm and mimos through as null when omitted', () => {
      const result = buscarCampanhasLegado('nulos@ex.com', [entry({ email: 'nulos@ex.com' })]);
      expect(result[0]).toMatchObject({ utm: null, mimos: null });
    });

    it('preserves mimos === 0 as 0 — the falsy-zero trap (0 mimos ≠ hidden count)', () => {
      const entries = [entry({ email: 'zero@ex.com', mimos: 0 })];
      expect(buscarCampanhasLegado('zero@ex.com', entries)[0]?.mimos).toBe(0);
    });
  });

  describe('purity & inputs', () => {
    it('returns [] for an empty entries array', () => {
      expect(buscarCampanhasLegado('qualquer@ex.com', [])).toEqual([]);
    });

    it('does not mutate the injected entries array', () => {
      const entries = [entry({ email: 'imutavel@ex.com', nome: null })];
      const snapshot = structuredClone(entries);
      void buscarCampanhasLegado('imutavel@ex.com', entries);
      expect(entries).toEqual(snapshot);
    });
  });
});

describe('LegacyUserEntrySchema — malformed export rows throw boot-loud (aperture-8jcec)', () => {
  it('rejects a row missing email', () => {
    expect(() => LegacyUserEntrySchema.parse({ nome: 'Sem email' })).toThrow();
  });

  it('rejects an empty-string email (min 1)', () => {
    expect(() => LegacyUserEntrySchema.parse({ email: '' })).toThrow();
  });

  it('rejects a WHITESPACE-ONLY email — trim runs before min(1), the match-anything row dies at boot (belt)', () => {
    expect(() => LegacyUserEntrySchema.parse({ email: ' ' })).toThrow();
    expect(() => LegacyUserEntrySchema.parse({ email: '\t\n' })).toThrow();
  });

  it('rejects an empty-string nome — present-but-blank titles die at boot (belt)', () => {
    expect(() => LegacyUserEntrySchema.parse({ email: 'a@ex.com', nome: '' })).toThrow();
  });

  it('rejects a stringly-typed mimos — "5" is not 5', () => {
    expect(() => LegacyUserEntrySchema.parse({ email: 'a@ex.com', mimos: '5' })).toThrow();
  });

  it('tolerates unknown extra keys from a fat export (strips, does not throw)', () => {
    const parsed = LegacyUserEntrySchema.parse({
      email: 'extra@ex.com',
      dateCreated: '2020-01-01',
      saldo: 123.45,
    });
    expect(parsed.email).toBe('extra@ex.com');
    expect(parsed).not.toHaveProperty('saldo');
  });

  it('defaults utm/nome/mimos to null when omitted', () => {
    expect(LegacyUserEntrySchema.parse({ email: 'defaults@ex.com' })).toMatchObject({
      utm: null,
      nome: null,
      mimos: null,
    });
  });
});

describe('LEGACY_USERS_SEED — shipped POC snapshot sanity (aperture-8jcec)', () => {
  // Database State Matters: an empty/typo'd seed renders a perfect-looking
  // skeleton of nothing. The POC's ONLY acceptance user must be in the file.
  it('contains the operator email (case-insensitive), so the POC walk can ever pass', () => {
    const match = buscarCampanhasLegado('FranciscoMateusVG@Gmail.com');
    expect(match.length).toBeGreaterThanOrEqual(1);
  });

  it('every seed row already satisfies the schema (module load did not lie)', () => {
    for (const row of LEGACY_USERS_SEED) {
      expect(() => LegacyUserEntrySchema.parse(row)).not.toThrow();
    }
  });
});
