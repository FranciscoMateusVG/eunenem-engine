import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';

/**
 * Persistência de Pagamentos (porta).
 *
 * `findByExternalRef` (aperture-xaha2): lookup by the provider-side session
 * reference stored on IntencaoPagamento.externalRef. Used by:
 *   - the Stripe webhook handler (aperture-24n36) to resolve `idPagamento`
 *     from the `session.id` in the event payload, then dispatch to
 *     finalizarPagamentoAprovado / finalizarPagamentoRejeitado.
 *   - the success-page proc `pagina.obterSucessoPagamento` (aperture-vkrkm)
 *     to render the confirmation view from our authoritative state.
 *
 * Implementations MUST treat `externalRef` as logically unique — a single
 * Stripe session can only back one Pagamento. The Postgres adapter enforces
 * this via a partial unique index; the in-memory adapter does a linear scan.
 * Returns `undefined` when no row matches (caller decides whether that's a
 * 404 or "webhook delivered for a payment we don't track").
 */
export interface PagamentoRepository {
  save(pagamento: Pagamento): Promise<void>;
  update(pagamento: Pagamento): Promise<void>;
  findById(id: IdPagamento): Promise<Pagamento | undefined>;
  findByExternalRef(externalRef: string): Promise<Pagamento | undefined>;
}
