import { z } from 'zod/v4';
import { MoneyCentsSchema } from '../../money.js';
import {
  IdContribuicaoPagamentoSchema,
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
  IdTransacaoExternaSchema,
} from './ids.js';

/**
 * Value object: a domain event emitted on payment lifecycle transitions
 * (`intent_created`, `approved`, `rejected`). Immutable record of a fact that
 * happened — no identity beyond its uuid, no behavior.
 *
 * `TipoEventoPagamento` (the discriminator) and `NomeProvedorPagamento` (used
 * by the external transaction record) are inlined as small associated VOs.
 *
 * `StatusPagamentoSchema` is referenced here but defined on the entity file
 * (status is intrinsic to the Pagamento aggregate's state machine).
 */

export const NomeProvedorPagamentoSchema = z.string().trim().min(1).max(120);
export type NomeProvedorPagamento = z.infer<typeof NomeProvedorPagamentoSchema>;

export const TipoEventoPagamentoSchema = z.enum([
  'payment.intent_created',
  'payment.approved',
  'payment.rejected',
]);
export type TipoEventoPagamento = z.infer<typeof TipoEventoPagamentoSchema>;

// Defined on the entity file; re-imported here to avoid a circular dep we'd
// need a separate ts file to break. Kept as inline literal to stay self-contained.
const StatusPagamentoSchemaLocal = z.enum(['pendente', 'aprovado', 'rejeitado']);

export const EventoPagamentoSchema = z.object({
  id: z.uuid(),
  tipo: TipoEventoPagamentoSchema,
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  idContribuicao: IdContribuicaoPagamentoSchema,
  amountCents: MoneyCentsSchema,
  status: StatusPagamentoSchemaLocal,
  idTransacaoExterna: IdTransacaoExternaSchema.optional(),
  ocorridoEm: z.date(),
});

export type EventoPagamento = Readonly<z.infer<typeof EventoPagamentoSchema>>;
