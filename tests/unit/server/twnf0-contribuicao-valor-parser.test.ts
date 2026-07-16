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
import { brlFromCents, centsFromBRL } from '../../../apps/eunenem-server/pages/lib/contribuicao.js';

/**
 * CHAR-FOR-CHAR mirror of the inline parse at ListaPresentesBody.tsx
 * :991 / :1151 / :1513 / :1651, composed with the REAL centsFromBRL. This
 * is exactly the string→cents pipeline a user's typed price travels on
 * add/edit. If those four call sites are ever refactored into a shared
 * helper, replace this mirror with a direct import of that helper.
 */
function parseValorInput(raw: string): number {
  const brl = parseFloat(raw.replace(',', '.')) || 0;
  return centsFromBRL(brl);
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
 * KNOWN BUG — thousand-separator prices collapse catastrophically.
 *
 * These `it.fails` cases encode the CORRECT expectation. They pass today
 * ONLY because the assertion inside throws (the parser is wrong). When the
 * parser is fixed, each `it.fails` will start FAILING — that is the signal
 * to drop `.fails` and promote it to a normal assertion.
 *
 * Repro (all values in cents; expected → actual):
 *   "1.500,00"     150000 → 150     (R$1.500,00 becomes R$1,50)
 *   "1.234,56"     123456 → 123     (R$1.234,56 becomes R$1,23)
 *   "2.000"        200000 → 200     (R$2.000    becomes R$2,00)
 *   "1.234.567,89" ... catastrophic truncation at the 2nd dot
 *
 * Root cause: apps/.../ListaPresentesBody.tsx `.replace(",", ".")` replaces
 * only the FIRST comma and leaves the thousand-separator dot(s) in place, so
 * parseFloat("1.500.00") === 1.5.
 */
describe('aperture-twnf0 — reais→cents parser KNOWN BUG (thousand separators)', () => {
  it.fails('"1.500,00" SHOULD be 150000 cents (actual: 150 — R$1,50)', () => {
    expect(parseValorInput('1.500,00')).toBe(150000);
  });

  it.fails('"1.234,56" SHOULD be 123456 cents (actual: 123 — R$1,23)', () => {
    expect(parseValorInput('1.234,56')).toBe(123456);
  });

  it.fails('"2.000" SHOULD be 200000 cents (actual: 200 — R$2,00)', () => {
    expect(parseValorInput('2.000')).toBe(200000);
  });

  it.fails('"1.234.567,89" SHOULD be 123456789 cents (actual: 123)', () => {
    expect(parseValorInput('1.234.567,89')).toBe(123456789);
  });
});
