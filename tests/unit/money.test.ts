import { describe, expect, it } from 'vitest';
import { MoneyCentsSchema } from '../../src/domain/money.js';

describe('MoneyCentsSchema', () => {
  it('accepts a positive integer', () => {
    expect(MoneyCentsSchema.safeParse(8000).success).toBe(true);
  });

  it('rejects zero', () => {
    expect(MoneyCentsSchema.safeParse(0).success).toBe(false);
  });

  it('rejects negative amounts', () => {
    expect(MoneyCentsSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects non-integers', () => {
    expect(MoneyCentsSchema.safeParse(10.5).success).toBe(false);
  });
});
