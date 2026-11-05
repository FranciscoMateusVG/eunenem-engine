import { describe, expect, it } from 'vitest';
import {
  ResolverManualFalhouRepasseInputSchema,
  ResolverManualPagoRepasseInputSchema,
} from '../../../../../src/use-cases/pagamentos/financeiro/resolver-manual-repasse.js';

const idRepasse = '10000000-0000-4000-8000-000000000001';
const resolvidoPor = 'admin@example.test';
describe('45h33 explicit manual resolution', () => {
  it('aperture-puali: accepts marking paid with only idRepasse + admin (motivo and reference optional)', () => {
    expect(
      ResolverManualPagoRepasseInputSchema.safeParse({
        idRepasse,
        resolvidoPor,
      }).success,
    ).toBe(true);
  });
  it('does not accept an unqualified no-payment assertion without a reason', () => {
    expect(
      ResolverManualFalhouRepasseInputSchema.safeParse({
        idRepasse,
        resolvidoPor,
      }).success,
    ).toBe(false);
  });
});
