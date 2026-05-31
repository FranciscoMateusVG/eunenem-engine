import { z } from 'zod/v4';

/**
 * Value object: the visitor's data attached to a Contribuição (nome + email
 * + optional mensagem). Immutable, equality is structural. Lives inside the
 * Contribuição aggregate root.
 *
 * `NomeContribuinte` is inlined as a field-level schema since it's only used here.
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
