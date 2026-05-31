import { z } from 'zod/v4';
import { MoneyCentsSchema } from '../../money.js';
import { IdContribuicaoPagamentoSchema } from './ids.js';

/**
 * Value object: the snapshot of `ComposicaoValores` received from Taxas at
 * intent-creation time. Immutable; Pagamentos never recalculates the fee —
 * it preserves what it was given.
 *
 * `ResponsavelTaxaPagamento` is inlined as the literal `'contribuinte'`
 * (one-of enum) since it's intrinsic to the snapshot.
 */

export const ResponsavelTaxaPagamentoSchema = z.literal('contribuinte');
export type ResponsavelTaxaPagamento = z.infer<typeof ResponsavelTaxaPagamentoSchema>;

export const SnapshotComposicaoValoresSchema = z.object({
  idContribuicao: IdContribuicaoPagamentoSchema,
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  /**
   * Buyer-paid provider surcharge (aperture-uyw8i). For Stripe card
   * payments this is the 3.9% + R$0.39 gross-up. Defaults to 0 for
   * Pix flows + backward compat with pre-uyw8i snapshots in old rows
   * (Postgres returns NULL for unset columns; we coerce to 0 here).
   * Excluded from the platform-fee base — feeAmountCents stays on
   * contributionAmountCents.
   */
  surchargeCents: z.number().int().nonnegative().default(0),
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaPagamentoSchema,
});

export type SnapshotComposicaoValores = Readonly<z.infer<typeof SnapshotComposicaoValoresSchema>>;
