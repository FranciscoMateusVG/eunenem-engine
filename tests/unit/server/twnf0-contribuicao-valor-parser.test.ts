/**
 * aperture-twnf0 — data-correctness for the reais→cents PARSER in the
 * creator add-mimo / edit-mimo forms.
 *
 * WHERE THE MONEY IS CONVERTED
 * ────────────────────────────
 * The tRPC layer takes `valor` already in CENTS (ValorContribuicaoCentavos-
 * Schema, apps/eunenem-server/server/trpc/contribuicao-router.ts). The
 * reais→cents conversion therefore happens in the FRONTEND, and it is the
 * one place a "R$50,00 became R$0,50" class of bug can hide. It has two
 * halves:
 *
 *   1. A string→float parse, inlined IDENTICALLY at FOUR call sites in
 *      apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.tsx
 *          line  991  (add form — personPriceNum, live validity)
 *          line 1151  (edit form — priceNum, live validity)
 *          line 1513  (addItem   — the value actually SENT on create)
 *          line 1651  (saveEdit  — the value actually SENT on update)
 *      each: `parseFloat(<price>.replace(",", ".")) || 0`
 *
 *   2. `centsFromBRL(brl)` in apps/eunenem-server/pages/lib/contribuicao.ts
 *      = `Math.round(brl * 100)` — the REAL exported helper, imported below.
 *
 * `centsFromBRL` is imported and tested directly. The string→float half is
 * inlined inside a heavy React/tsx component (cannot be imported in a node
 * test env), so `parseValorInput` below is a CHAR-FOR-CHAR mirror of that
 * inline expression — feeding the REAL centsFromBRL — so the composed
 * string→cents behavior (and its bug) is pinned to real code where possible.
 *
 * REAL BUG SURFACED HERE (see the "KNOWN BUG" describe block):
 *   `.replace(",", ".")` replaces only the FIRST comma and does NOT strip
 *   the Brazilian thousand-separator dot, so parseFloat truncates at the
 *   second dot. Any user-typed thousand separator collapses the value:
 *   "1.500,00" (R$1.500,00) → 150 cents (R$1,50). Reported to Izzy.
 */
import { describe, expect, it } from 'vitest';
import {
  brlFromCents,
  centsFromBRL,
  parseValorBRL,
} from '../../../apps/eunenem-server/pages/lib/contribuicao.js';

/**
 * The string→cents pipeline a user's typed price travels on add/edit. As of
 * aperture-t8zj5 the inline parse at ListaPresentesBody.tsx :991/:1151/:1513/
 * :1651 was extracted into the shared `parseValorBRL` helper (which fixes the
 * thousand-separator bug), so this now composes the REAL helper directly
 * instead of mirroring the old buggy inline expression.
 */
function parseValorInput(raw: string): number {
  return centsFromBRL(parseValorBRL(raw));
}

describe('aperture-twnf0 — centsFromBRL / brlFromCents (real exported helpers)', () => {
  it.each([
    [50, 5000],
    [49.9, 4990],
    [0.5, 50],
    [19.99, 1999],
    [1500, 150000],
    [1234.56, 123456],
    [0, 0],
  ])('centsFromBRL(%d) === %d', (brl, cents) => {
    expect(centsFromBRL(brl)).toBe(cents);
  });

  it('rounds to the nearest cent (no floating-point drift)', () => {
    // 35.35 * 100 === 3534.9999999999995 in IEEE-754; Math.round rescues it.
    expect(centsFromBRL(35.35)).toBe(3535);
  });

  it('round-trips cents → brl → cents for whole-cent values', () => {
    for (const cents of [1, 50, 4990, 5000, 123456, 150000]) {
      expect(centsFromBRL(brlFromCents(cents))).toBe(cents);
    }
  });
});

describe('aperture-twnf0 — reais→cents parser (typed price → cents)', () => {
  // The values users actually type on the add/edit forms, WITHOUT a
  // thousand separator — these are correct today and must stay correct.
  it.each([
    ['50,00', 5000], // the exact string e2e/painel-adicionar-qty.spec.ts fills
    ['50', 5000], // bare integer reais
    ['0,50', 50], // sub-real
    ['19,99', 1999], // fractional cents
    ['1500,00', 150000], // R$1.500 typed WITHOUT a thousand separator — fine
    ['1234,56', 123456], // R$1.234,56 typed WITHOUT a thousand separator — fine
  ])('parseValorInput(%j) === %d cents', (input, cents) => {
    expect(parseValorInput(input)).toBe(cents);
  });

  it('empty / non-numeric input falls back to 0 (|| 0 guard)', () => {
    expect(parseValorInput('')).toBe(0);
    expect(parseValorInput('abc')).toBe(0);
  });
});

/**
 * FIXED (aperture-t8zj5) — thousand-separator prices now parse correctly.
 *
 * These were `it.fails` cases holding the CORRECT expectation while the bug
 * was live; the parser is now fixed (`parseValorBRL` strips thousand-dots and
 * normalizes the decimal comma), so they are promoted to normal `it`
 * assertions. If they ever start failing again, the ~1000× undercharge has
 * regressed.
 *
 *   "1.500,00"     → 150000    (R$1.500,00, not R$1,50)
 *   "1.234,56"     → 123456
 *   "2.000"        → 200000    (R$2.000, thousand-separated)
 *   "1.234.567,89" → 123456789
 */
describe('aperture-t8zj5 — reais→cents parser handles thousand separators', () => {
  it('"1.500,00" → 150000 cents', () => {
    expect(parseValorInput('1.500,00')).toBe(150000);
  });

  it('"1.234,56" → 123456 cents', () => {
    expect(parseValorInput('1.234,56')).toBe(123456);
  });

  it('"2.000" → 200000 cents', () => {
    expect(parseValorInput('2.000')).toBe(200000);
  });

  it('"1.234.567,89" → 123456789 cents', () => {
    expect(parseValorInput('1.234.567,89')).toBe(123456789);
  });
});
