import { describe, expect, it } from 'vitest';
import { SlugUsuarioSchema } from '../../../src/domain/usuario/value-objects/slug-usuario.js';

// aperture-khbow — SlugUsuario VO validation. The regex contract is the
// public surface that /painel/[slug] depends on; lock the boundary cases.

describe('SlugUsuarioSchema', () => {
  describe('accepts valid slugs', () => {
    it.each([
      'helena',
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
});
