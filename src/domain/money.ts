import { z } from 'zod/v4';

/**
 * Montante em centavos (unidade mínima), inteiro positivo.
 * Convenção didática para BRL e evitar erros de ponto flutuante em `number` em reais.
 *
 * Use `MoneyCentsNonNegativeSchema` para campos agregados que podem
 * legitimamente ser zero (ex: surcharge total em flows PIX — não há
 * cartão, então o total surcharge do carrinho é 0).
 */
export const MoneyCentsSchema = z.number().int().positive();
export type MoneyCents = z.infer<typeof MoneyCentsSchema>;

/**
 * Plan 0016 Phase 2 (aperture-daxwm bugfix): inteiro NÃO-negativo
 * (zero é válido). Para campos como `totalSurchargeCents` no aggregate
 * snapshot da IntencaoPagamento: PIX flows têm zero surcharge porque
 * não existe item passthrough_surcharge no cart. O `MoneyCentsSchema`
 * positivo rejeitava o `0` e quebrava `PagamentoSchema.parse` na
 * hidratação de pagamentos PIX no postgres (aperture-daxwm).
 *
 * Use this for AGGREGATE / SUM fields where 0 is structurally valid
 * (no items contributing to the sum). Single-item amount fields stay
 * on `MoneyCentsSchema` — a `passthrough_surcharge` item only exists
 * when surcharge > 0; a contribuição-tipo item's `lineContributionAmountCents`
 * comes from `contribuicao.valor` which is positive by `MoneyCentsSchema`.
 */
export const MoneyCentsNonNegativeSchema = z.number().int().nonnegative();
export type MoneyCentsNonNegative = z.infer<typeof MoneyCentsNonNegativeSchema>;
