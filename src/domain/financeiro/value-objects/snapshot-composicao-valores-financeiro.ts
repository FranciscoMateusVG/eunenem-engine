import { z } from 'zod/v4';
import { MoneyCentsSchema } from '../../money.js';

/**
 * Value object: snapshot of the value composition received by Financeiro from
 * the orchestrator (originally calculated by Taxas). Immutable; Financeiro
 * never recalculates the fee — it uses exactly what it was given.
 *
 * Invariant (aperture-uyw8i extended):
 *   `receiverAmountCents + feeAmountCents + surchargeCents === totalPaidCents`
 *   `receiverAmountCents === contributionAmountCents`
 *   (`surchargeCents` defaults to 0 for Pix / non-surcharge providers)
 *
 * `ResponsavelTaxaFinanceiro` is inlined as the BC-local literal so Financeiro
 * does not depend on Taxas / Pagamentos domain types.
 *
 * **`surchargeCents`** is the buyer-paid provider gross-up (Stripe 3.9% +
 * R$0.39 for card). Excluded from the platform-fee base — Financeiro's
 * `platformRevenueAmountCents` continues to use `feeAmountCents` directly
 * (registrarEfeitosFinanceirosPagamentoAprovado line 96), so eunenem
 * revenue receipts net out to the intended rate regardless of surcharge.
 */

export const ResponsavelTaxaFinanceiroSchema = z.literal('contribuinte');
export type ResponsavelTaxaFinanceiro = z.infer<typeof ResponsavelTaxaFinanceiroSchema>;

export const SnapshotComposicaoValoresFinanceiroSchema = z.object({
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  surchargeCents: z.number().int().nonnegative().default(0),
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaFinanceiroSchema,
});

export type SnapshotComposicaoValoresFinanceiro = Readonly<
  z.infer<typeof SnapshotComposicaoValoresFinanceiroSchema>
>;
