import { z } from 'zod/v4';
import { MoneyCentsSchema } from '../../money.js';

/**
 * Value object: snapshot of the value composition received by Financeiro from
 * the orchestrator (originally calculated by Taxas). Immutable; Financeiro
 * never recalculates the fee — it uses exactly what it was given.
 *
 * Invariant (checked at entity-creation time): `receiverAmountCents +
 * feeAmountCents === totalPaidCents` and `receiverAmountCents ===
 * contributionAmountCents` (since the contribuinte pays the fee).
 *
 * `ResponsavelTaxaFinanceiro` is inlined as the BC-local literal so Financeiro
 * does not depend on Taxas / Pagamentos domain types.
 */

export const ResponsavelTaxaFinanceiroSchema = z.literal('contribuinte');
export type ResponsavelTaxaFinanceiro = z.infer<typeof ResponsavelTaxaFinanceiroSchema>;

export const SnapshotComposicaoValoresFinanceiroSchema = z.object({
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaFinanceiroSchema,
});

export type SnapshotComposicaoValoresFinanceiro = Readonly<
  z.infer<typeof SnapshotComposicaoValoresFinanceiroSchema>
>;
