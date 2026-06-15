import { z } from 'zod/v4';
import { IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
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
 *
 * **Plan 0016 multi-item (aperture-aj8qw).** Per operator review lock #19,
 * the event shape changes:
 *   - DROP `idContribuicao` (the IntencaoPagamento no longer carries one
 *     at root — items do).
 *   - ADD `idCampanha` (single, hoisted from items — cart-scope
 *     invariant).
 *   - ADD `numeroDeItens` (count of items in the cart, top-level integer
 *     for cheap log-grep summaries).
 *   - ADD `idsContribuicoes` (array of contribuição ids the cart touched
 *     — surcharge items contribute nothing here; an empty surcharge-only
 *     cart cannot exist per locked decision #7, so the array is always
 *     non-empty).
 *   - `amountCents` stays — semantically still "what the buyer paid"
 *     (now sourced from `composicaoValoresAggregate.totalPaidCents`).
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
  // Plan 0016 (aperture-aj8qw) per operator review lock #19:
  // idContribuicao removed; idCampanha + numeroDeItens + idsContribuicoes
  // replace it. amountCents kept as the cart's totalPaidCents.
  idCampanha: IdCampanhaSchema,
  numeroDeItens: z.number().int().positive(),
  idsContribuicoes: z.array(IdContribuicaoPagamentoSchema).min(1),
  amountCents: MoneyCentsSchema,
  status: StatusPagamentoSchemaLocal,
  idTransacaoExterna: IdTransacaoExternaSchema.optional(),
  ocorridoEm: z.date(),
});

export type EventoPagamento = Readonly<z.infer<typeof EventoPagamentoSchema>>;
