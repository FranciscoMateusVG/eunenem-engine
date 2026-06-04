import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';

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
  /**
   * Returns every Pagamento whose `intencao.idContribuicao` matches the
   * given contribuicao reference, in `criadoEm ASC` order (aperture-i0pz8).
   *
   * Used by the eunenem-v2 admin DDD-trace drill-down (epic aperture-rsidz,
   * W4) to list every payment attempt against a single contribuicao —
   * including the full lifecycle mix (pendente, aprovado, rejeitado). A
   * contribuicao can have multiple pagamentos over time when the visitor
   * retries after a rejection or when the saga reprocesses a flow.
   *
   * Returns an empty array when no pagamentos exist for the contribuicao
   * (caller decides whether that's a 404 or just an empty admin row).
   */
  findByContribuicao(idContribuicao: IdContribuicaoPagamento): Promise<readonly Pagamento[]>;
  /**
   * Lookup by the Stripe `pi_xxx` reference stored on
   * `intencao.paymentIntentExternalRef` (aperture-wif8s). Populated by
   * the webhook handler when `checkout.session.completed` arrives. Used
   * by the resolver for subsequent `payment_intent.*` events (which
   * carry pi_xxx in `event.data.object.id`) and as the primary lookup
   * path for `charge.*` events (which carry pi_xxx in
   * `event.data.object.payment_intent`).
   *
   * Postgres adapter uses the partial index
   * `pagamentos_intencao_pi_ref_idx ON (intencao_payment_intent_external_ref)
   * WHERE intencao_payment_intent_external_ref IS NOT NULL` for
   * selective scan. Returns `undefined` for unknown pi_xxx (handler
   * archives as orphan and exits cleanly — no error).
   */
  findByPaymentIntentExternalRef(pi: string): Promise<Pagamento | undefined>;
  /**
   * Lookup by the Stripe `ch_xxx` reference stored on
   * `intencao.chargeExternalRef` (aperture-wif8s). Populated by the
   * webhook handler when `payment_intent.succeeded` arrives (payload
   * carries `data.object.latest_charge`). Used by the resolver as a
   * FALLBACK for `charge.*` events when the primary
   * findByPaymentIntentExternalRef lookup misses (e.g. a re-processed
   * charge event after backfill populated ch but the pi link is
   * missing). Returns `undefined` for unknown ch_xxx.
   */
  findByChargeExternalRef(ch: string): Promise<Pagamento | undefined>;
  /**
   * Plan 0015 / aperture-ucgok. Bulk EXISTS predicate: returns the
   * subset of the input IDs that have AT LEAST ONE aprovado pagamento.
   * One indexed query for the whole set (the Postgres adapter uses
   * `pagamentos_aprovado_por_contribuicao_idx` — the partial index
   * created by migration 019). Used by:
   *   - `contribuicaoEstaIndisponivel` (single-id wrapper, the saga's
   *     early-fail gate);
   *   - `obterContribuicoesPrecalculadasCampanha` (visitor-facing
   *     read; computes the "indisponivel" badge for every gift slot
   *     in one query instead of N).
   *
   * Returns an empty array when none of the input IDs have aprovado
   * pagamentos. Order of returned IDs is not guaranteed; callers
   * should treat the result as a Set.
   */
  findIdsContribuicoesComPagamentoAprovado(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<readonly IdContribuicaoPagamento[]>;
}
