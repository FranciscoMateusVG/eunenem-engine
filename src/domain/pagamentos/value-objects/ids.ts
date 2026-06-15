import { z } from 'zod/v4';

/**
 * Identifier value objects for the Pagamentos BC. The three ENGINE-local
 * identifiers (Pagamento, IntencaoPagamento, ContribuicaoPagamento) are
 * branded UUIDs — value-identity, immutable, no behavior, minted by us so
 * we get to constrain the shape.
 *
 * `IdContribuicaoPagamento` is the BC-local mirror of the contribuição
 * reference (kept here so Pagamentos does not depend on Arrecadação's
 * domain types).
 *
 * `IdTransacaoExterna` is DIFFERENT — it carries the external payment
 * provider's identifier (Stripe `pi_xxx`, Pagarme tid, fake adapter UUID,
 * etc.). The shape is the provider's choice, not ours, so we accept any
 * non-empty bounded string. Constraining it to `z.uuid()` previously
 * crashed every Stripe webhook with `Invalid UUID` at finalize-time
 * (banked 2026-05-31 aiipy verify — same lesson as the `z.url()` vs
 * relative-path bug from FLASHBACK §6: validators that don't reflect
 * real provider shapes are silent footguns).
 */

export const IdPagamentoSchema = z.uuid();
export type IdPagamento = z.infer<typeof IdPagamentoSchema>;

export const IdIntencaoPagamentoSchema = z.uuid();
export type IdIntencaoPagamento = z.infer<typeof IdIntencaoPagamentoSchema>;

export const IdTransacaoExternaSchema = z.string().min(1).max(200);
export type IdTransacaoExterna = z.infer<typeof IdTransacaoExternaSchema>;

export const IdContribuicaoPagamentoSchema = z.uuid();
export type IdContribuicaoPagamento = z.infer<typeof IdContribuicaoPagamentoSchema>;

/**
 * Plan 0016 (aperture-aj8qw): identifier for `ItemDoPagamento`, the
 * per-line decomposition of an IntencaoPagamento. UUID, caller-controlled
 * at construction time — matches the existing engine convention where
 * the use-case threads UUIDs through to entity factories.
 */
export const IdItemDoPagamentoSchema = z.uuid();
export type IdItemDoPagamento = z.infer<typeof IdItemDoPagamentoSchema>;
