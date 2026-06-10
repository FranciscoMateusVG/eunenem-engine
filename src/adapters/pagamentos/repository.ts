import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';

/**
 * Visitor-safe mural projection (aperture-7eci9). Surfaces ONLY the fields
 * the public `/pagina/<slug>` mural needs to render a recado card: opaque
 * pagamento id, contribuinte's display name, message body, and timestamp.
 *
 * Deliberately omits everything else from the Pagamento aggregate
 * (`email`, `idCampanha`, internal status, composição values, intencao id,
 * any item-level data). This is what the `pagina.obterMural` procedure
 * returns straight to a public visitor — no further projection needed.
 */
export interface MuralRecadoProjection {
  readonly idPagamento: IdPagamento;
  readonly contribuinteNome: string;
  readonly mensagem: string;
  readonly criadoEm: Date;
}

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
   * Plan 0016 / aperture-eg1s2. Bulk SUM aggregator: returns the total
   * quantidade consumed per contribuição across all aprovado
   * pagamentos' contribuicao-tipo items. One indexed query for the
   * whole set (Postgres adapter uses
   * `idx_intencao_items_contribuicao_aprovado` — the partial index
   * INCLUDE (quantidade) created by migration 022). Replaces the
   * pre-0016 `findIdsContribuicoesComPagamentoAprovado` binary
   * predicate.
   *
   * Returns a Map keyed by idContribuicao. Entries:
   *   - When at least one aprovado item exists for the contribuição
   *     → returns the SUM of `quantidade` across all of them.
   *   - When no aprovado item exists → returns 0.
   *
   * Empty input returns an empty Map without touching the DB.
   *
   * Used by:
   *   - `quantidadeRestante(contribuicao)` use-case (the slot's
   *     remaining cap; subtracts this sum from contribuicao.quantidade).
   *   - `esgotada(contribuicao)` use-case (derived: quantidadeRestante <= 0).
   *   - `obterContribuicoesPrecalculadasCampanha` (visitor-facing
   *     read; computes the N/M badge for every gift slot in one query
   *     instead of N).
   *
   * Note on overshoot: the sum can exceed contribuicao.quantidade
   * (locked decision #10 of plan 0016 — admin pockets the extra money,
   * the predicate just surfaces esgotada=true).
   */
  somarQuantidadesContribuicoesEmPagamentosAprovados(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<IdContribuicaoPagamento, number>>;
  /**
   * Plan 0015 / aperture-6iqum. Bulk lookup of the most-recent
   * aprovado pagamento's `intencao.contribuinte` for each requested
   * idContribuicao. Used by the admin contribuições list to surface
   * "presented by X" inline on the row.
   *
   * Returns a Map keyed by idContribuicao. Entries:
   *   - When at least one aprovado pagamento exists with a non-null
   *     contribuinte → returns the contribuinte of the MOST RECENT
   *     aprovado pagamento (by criadoEm DESC). Mensagem may be
   *     undefined on the engine side (DadosContribuinte optional
   *     field); callers normalize at the wire boundary.
   *   - When all aprovado pagamentos have null contribuinte
   *     (anonymous checkout) → null entry.
   *   - When no aprovado pagamento exists → key absent from Map.
   *
   * Empty input returns an empty Map without touching the DB.
   *
   * Postgres adapter uses `DISTINCT ON (id_contribuicao)` ordered by
   * `id_contribuicao, criado_em DESC` — a single indexed query for
   * the whole set. Memory adapter filters + groups in-process.
   */
  findContribuintesFromLatestAprovadoPagamento(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<string, { nome: string; email: string; mensagem?: string } | null>>;
  /**
   * Visitor mural read (aperture-7eci9). Returns aprovado pagamentos for
   * `idCampanha` whose `intencao.contribuinte.mensagem` is a non-empty
   * string, projected to the visitor-safe `MuralRecadoProjection` shape.
   *
   * Ordering: `criadoEm DESC` (newest recados first).
   *
   * Filter rules:
   *   - status === 'aprovado' (Stripe-settled only — pendings are noise)
   *   - intencao.contribuinte is non-null AND mensagem is a non-empty
   *     string after trim. Anonymous-checkout pagamentos (contribuinte
   *     null) and "no message" pagamentos (contribuinte set, mensagem
   *     missing/empty) are excluded.
   *
   * Projection omits everything the visitor doesn't need / shouldn't see:
   * email, internal ids beyond opaque `idPagamento`, item-level data.
   *
   * `limit` caps how many recados the visitor mural pulls in one page —
   * defaults are policy at the caller (the procedure today asks for 50).
   * Empty array when no matches.
   */
  findMensagensMuralByCampanha(
    idCampanha: IdCampanha,
    limit: number,
  ): Promise<readonly MuralRecadoProjection[]>;
}
