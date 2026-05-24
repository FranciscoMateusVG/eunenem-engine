import { z } from 'zod/v4';

/**
 * Value object: payment method enum. Today only `pix` and `credit_card` are
 * supported. Immutable, equality by value.
 */
export const MetodoPagamentoSchema = z.enum(['pix', 'credit_card']);
export type MetodoPagamento = z.infer<typeof MetodoPagamentoSchema>;
