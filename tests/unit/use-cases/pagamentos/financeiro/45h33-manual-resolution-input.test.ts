import { describe, expect, it } from 'vitest';
import {
  ResolverManualFalhouRepasseInputSchema,
  ResolverManualPagoRepasseInputSchema,
} from '../../../../../src/use-cases/pagamentos/financeiro/resolver-manual-repasse.js';

const idRepasse = '10000000-0000-4000-8000-000000000001';
const resolvidoPor = 'admin@example.test';
describe('45h33 explicit manual resolution', () => {
  it('does not accept marking paid without the mandatory reason', () => {
    expect(
      ResolverManualPagoRepasseInputSchema.safeParse({
        idRepasse,
        resolvidoPor,
        interCodigoSolicitacao: 'bank-reference',
      }).success,
    ).toBe(false);
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
