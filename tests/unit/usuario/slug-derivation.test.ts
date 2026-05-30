import { describe, expect, it } from 'vitest';
import { deriveSlugBase, slugWithSuffix } from '../../../src/domain/usuario/slug-derivation.js';

// aperture-khbow — slug-derivation logic. Pure functions, no I/O — easy to
// test exhaustively at the boundaries that matter (operator's name shapes).

describe('deriveSlugBase', () => {
  it.each([
    ['Francisco', 'francisco'],
    ['FRANCISCO', 'francisco'],
    ['francisco', 'francisco'],
    // First-word convention
    ['Maria Silva', 'maria'],
    ['Maria  Silva', 'maria'],
    ['Helena Souza Costa', 'helena'],
    // Diacritics
    ['André', 'andre'],
    ['Marília', 'marilia'],
    ['João', 'joao'],
    ['Conceição', 'conceicao'],
    // Hyphens / punctuation in first segment
    ['Jean-Paul Sartre', 'jean'],
    // "O'Brien" → first segment "o" (1 char) is below the 3-char minimum
    // → fallback to "usuario" (caller resolves collisions with a suffix).
    ["O'Brien", 'usuario'],
  ])('derives "%s" → "%s"', (input, expected) => {
    expect(deriveSlugBase(input)).toBe(expected);
  });

  it('falls back to "usuario" when sanitisation produces an empty string', () => {
    expect(deriveSlugBase('!!!')).toBe('usuario');
    expect(deriveSlugBase('   ')).toBe('usuario');
    expect(deriveSlugBase('123')).toBe('usuario'); // digits-only fails the leading-letter rule
  });

  it('falls back to "usuario" when the derived first segment is shorter than 3 chars', () => {
    expect(deriveSlugBase('Al')).toBe('usuario');
    expect(deriveSlugBase('A')).toBe('usuario');
  });

  it('truncates very long first segments to 30 chars', () => {
    const longName = 'a'.repeat(60);
    const result = deriveSlugBase(longName);
    expect(result.length).toBe(30);
    expect(result).toMatch(/^[a-z][a-z0-9-]{2,29}$/);
  });
});

describe('slugWithSuffix', () => {
  it('returns the base unchanged for attempt 1', () => {
    expect(slugWithSuffix('helena', 1)).toBe('helena');
    expect(slugWithSuffix('helena', 0)).toBe('helena'); // defensive
  });

  it('appends -N for attempt ≥ 2', () => {
    expect(slugWithSuffix('helena', 2)).toBe('helena-2');
    expect(slugWithSuffix('helena', 3)).toBe('helena-3');
    expect(slugWithSuffix('helena', 50)).toBe('helena-50');
  });

  it('trims the base to keep the total length ≤ 30 chars when suffixing', () => {
    const longBase = 'a'.repeat(30);
    const suffixed = slugWithSuffix(longBase, 2);
    expect(suffixed.length).toBeLessThanOrEqual(30);
    expect(suffixed.endsWith('-2')).toBe(true);
  });

  it('produces a slug that satisfies the VO regex even with long bases', () => {
    const longBase = 'a'.repeat(30);
    const suffixed = slugWithSuffix(longBase, 99);
    expect(suffixed).toMatch(/^[a-z][a-z0-9-]{2,29}$/);
  });
});
