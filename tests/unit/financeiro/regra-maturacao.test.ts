import { describe, expect, it } from 'vitest';
import {
  calcularMaturaEm,
  REGRAS_MATURACAO_PADRAO,
} from '../../../src/domain/financeiro/value-objects/regra-maturacao.js';

/**
 * Tests for aperture-led0r — the maturation rule + pure
 * `calcularMaturaEm` function.
 *
 * Acceptance criterion (a): PIX = criadoEm + 1h, credit_card =
 * criadoEm + 30 days, unknown metodo throws.
 */
describe('calcularMaturaEm (aperture-led0r, plano 0006)', () => {
  const criadoEm = new Date('2026-05-01T12:00:00.000Z');

  it('PIX: criadoEm + 1 hour', () => {
    expect(calcularMaturaEm('pix', criadoEm)).toEqual(new Date('2026-05-01T13:00:00.000Z'));
  });

  it('credit_card: criadoEm + 30 calendar days', () => {
    expect(calcularMaturaEm('credit_card', criadoEm)).toEqual(
      new Date('2026-05-31T12:00:00.000Z'),
    );
  });

  it('credit_card across a month boundary handles wraparound correctly', () => {
    // 2026-02-15 + 30d = 2026-03-17 (Feb 2026 has 28 days)
    const fevEm = new Date('2026-02-15T08:30:00.000Z');
    expect(calcularMaturaEm('credit_card', fevEm)).toEqual(new Date('2026-03-17T08:30:00.000Z'));
  });

  it('credit_card across year boundary handles wraparound correctly', () => {
    const dezEm = new Date('2026-12-15T00:00:00.000Z');
    expect(calcularMaturaEm('credit_card', dezEm)).toEqual(new Date('2027-01-14T00:00:00.000Z'));
  });

  it('PIX preserves wall-clock time across the hour add (no DST surprise for UTC base)', () => {
    const samples = [
      new Date('2026-03-15T11:59:59.999Z'),
      new Date('2026-10-30T22:30:45.123Z'),
    ];
    for (const s of samples) {
      const result = calcularMaturaEm('pix', s);
      expect(result.getTime() - s.getTime()).toBe(60 * 60 * 1000);
    }
  });

  it('throws a clear error on an unknown metodo (defensive — future metodos must land in the rules table first)', () => {
    expect(() =>
      // Cast to any so TS doesn't reject the invalid literal at compile time
      // — the runtime guard is what we're testing.
      calcularMaturaEm('boleto' as never, criadoEm),
    ).toThrow(/Maturação não definida para método: boleto/);
  });

  it('does not mutate the input criadoEm Date', () => {
    const input = new Date('2026-05-01T12:00:00.000Z');
    const originalMs = input.getTime();
    calcularMaturaEm('pix', input);
    calcularMaturaEm('credit_card', input);
    expect(input.getTime()).toBe(originalMs);
  });
});

describe('REGRAS_MATURACAO_PADRAO (aperture-led0r)', () => {
  it('exposes the PIX + credit_card rules with documented values', () => {
    expect(REGRAS_MATURACAO_PADRAO.pix).toEqual({ days: 0, hours: 1 });
    expect(REGRAS_MATURACAO_PADRAO.credit_card).toEqual({ days: 30 });
  });
});
