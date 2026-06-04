import { z } from 'zod/v4';

/**
 * Value object: the visitor's data attached to a payment (nome + email +
 * optional mensagem). Immutable, equality is structural. Lives inside the
 * `IntencaoPagamento` entity (which belongs to the Pagamento aggregate root).
 *
 * Moved here from `arrecadacao/value-objects` by plan 0015 Phase 1
 * (aperture-7pqee). Before 0015 the contribuinte lived on the Contribuição
 * aggregate; the locked decision under 0015 puts it on IntencaoPagamento so
 * each gift attempt carries its own contribuinte snapshot (1:N contribuição
 * → pagamentos). The arrecadacao path keeps a deprecated re-export for one
 * release cycle for the use-cases / adapters still importing the old path.
 *
 * `NomeContribuinte` is inlined as a field-level schema since it's only
 * used here.
 *
 * **`mensagem` (aperture-m95f3):** the visitor's free-text gift message
 * ("recadinho"). Collected by the payment provider in the checkout flow
 * (Stripe embedded UI via custom_fields) and persisted here at
 * finalization time. Optional — a visitor may pay without leaving a
 * message. Max 255 chars (matches Stripe's custom_fields text limit).
 */

export const NomeContribuinteSchema = z
  .string()
  .trim()
  .min(1, 'Nome do contribuinte nao pode ser vazio')
  .max(120);

export const DadosContribuinteSchema = z.object({
  nome: NomeContribuinteSchema,
  email: z.string().trim().email('Email invalido').max(320),
  mensagem: z.string().trim().max(255).optional(),
});

export type DadosContribuinte = Readonly<z.infer<typeof DadosContribuinteSchema>>;
