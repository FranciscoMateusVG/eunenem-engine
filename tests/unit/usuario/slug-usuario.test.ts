import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  SlugUsuarioSchema,
} from '../../../src/domain/usuario/value-objects/slug-usuario.js';

// aperture-khbow — SlugUsuario VO validation. The regex contract is the
// public surface that /painel/[slug] depends on; lock the boundary cases.

describe('SlugUsuarioSchema', () => {
  describe('accepts valid slugs', () => {
    it.each([
      'helena',
      'joao-2026',
      'bebe-luiza',
      'francisco',
      'maria-silva-2',
      'a3c',
      'us-2',
      'francisco-50',
      // upper bound (30 chars)
      'a234567890123456789012345678901'.slice(0, 30),
    ])('parses "%s"', (input) => {
      expect(SlugUsuarioSchema.parse(input)).toBe(input);
    });
  });

  describe('rejects invalid slugs', () => {
    it.each([
      // too short (must be ≥3)
      'a',
      'ab',
      // too long (>30)
      'a23456789012345678901234567890123',
      // uppercase
      'Helena',
      'HELENA',
      // starts with digit
      '2-francisco',
      // starts with hyphen
      '-helena',
      // empty
      '',
      // diacritics
      'andré',
      // spaces
      'maria silva',
      // underscores
      'maria_silva',
      // disallowed punctuation
      'francisco!',
      'francisco.',
    ])('rejects "%s"', (input) => {
      expect(() => SlugUsuarioSchema.parse(input)).toThrow();
    });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(SlugUsuarioSchema.parse('  helena  ')).toBe('helena');
  });

  // aperture-vd1do — reserved-words denylist. A vanity slug must not claim a
  // top-level app route segment (path-collision) or a standard reserved word.
  describe('rejects reserved slugs (denylist)', () => {
    it.each([
      // real top-level routes
      'admin',
      'api',
      'painel',
      'pagina',
      'healthz',
      'public',
      'products',
      'listas-prontas',
      // standard reserved words
      'sucesso',
      'login',
      'me',
      'conta',
      'null',
      'undefined',
    ])('rejects reserved "%s"', (input) => {
      expect(() => SlugUsuarioSchema.parse(input)).toThrow();
      expect(SlugUsuarioSchema.safeParse(input).success).toBe(false);
    });

    it('rejects a reserved word even with surrounding whitespace (trim then deny)', () => {
      expect(() => SlugUsuarioSchema.parse('  admin  ')).toThrow();
    });

    it('still accepts slugs that merely CONTAIN a reserved word (exact match only)', () => {
      // `api` is reserved; `apize` / `api-helena` are not.
      expect(SlugUsuarioSchema.parse('apize')).toBe('apize');
      expect(SlugUsuarioSchema.parse('api-helena')).toBe('api-helena');
    });

    it('exposes the denylist as a ReadonlySet for callers/UI', () => {
      expect(RESERVED_SLUGS.has('admin')).toBe(true);
      expect(RESERVED_SLUGS.has('helena')).toBe(false);
    });
  });
});
