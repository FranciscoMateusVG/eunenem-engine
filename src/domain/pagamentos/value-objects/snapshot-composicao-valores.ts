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
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  responsavelTaxa: ResponsavelTaxaPagamentoSchema,
});

export type SnapshotComposicaoValores = Readonly<z.infer<typeof SnapshotComposicaoValoresSchema>>;
