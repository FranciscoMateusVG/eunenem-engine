import type { DadosContribuinte } from '../../domain/arrecadacao/value-objects/dados-contribuinte.js';
import type {
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { TipoOpcaoContribuicao } from '../../domain/arrecadacao/value-objects/opcao-contribuicao.js';
import type { MoneyCents } from '../../domain/money.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import type { MetodoPagamento } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';

/**
 * Pre-authorisation checkout-session lifecycle (port) — aperture-xaha2.
 *
 * Sibling to `PagamentoProvider`. Where `PagamentoProvider.solicitarPagamento`
 * models the SYNCHRONOUS approve/reject handshake (Pagarme / Pix-direct
 * topology where the backend mints the transaction in-band), this port
 * models the ASYNCHRONOUS pre-session + webhook topology (Stripe embedded
 * checkout, Stripe Connect, any provider that gives the frontend a
 * client-side session token to mount before payment).
 *
 * **Why a sibling port, not extending PagamentoProvider:**
 * A future Pagarme-direct adapter implements `PagamentoProvider` but has
 * no session lifecycle. A future Stripe Connect adapter implements both.
 * Putting both contracts on one port would force ISP-violating empty stubs
 * on every adapter that doesn't need them. (Decision banked on epic
 * aperture-aiipy, 2026-05-30, with operator: "we don't want to couple
 * with stripe".)
 *
 * **Contract:**
 * - `criarSessaoCheckout` creates the provider-side pre-authorisation
 *   session. Returns `{ sessionId, clientSecret, externalRef }`. The
 *   `externalRef` IS the provider's canonical reference for this session
 *   (for Stripe: same value as `sessionId`); we expose both names because
 *   downstream consumers conceptualise them differently — `sessionId` is
 *   the frontend-mountable identifier, `externalRef` is what we persist on
 *   IntencaoPagamento for later webhook resolution. They MAY be the same
 *   string for any given adapter.
 * - `obterSessaoCheckout` retrieves the provider session state. Used by
 *   the success page (`pagina.obterSucessoPagamento`) to render
 *   confirmation, and as a defensive read by the webhook handler when the
 *   event payload omits a field we need.
 *
 * **Idempotency:** `criarSessaoCheckout` is expected to be idempotent on
 * the same `idPagamento` — Stripe achieves this via the SDK's
 * `idempotencyKey` parameter (we use `idPagamento` as the key). A second
 * call with the same `idPagamento` MUST return the same session, not
 * create a duplicate.
 */
export interface CriarSessaoCheckoutInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly idContribuicao: IdContribuicao;
  readonly idOpcaoContribuicao: IdOpcaoContribuicao;
  readonly tipoOpcao: TipoOpcaoContribuicao;
  readonly nomeItem: string;
  readonly amountCents: MoneyCents;
  readonly metodo: MetodoPagamento;
  /**
   * Contribuinte data — used to PREFILL Stripe's custom_fields nome,
   * NOT collected by the saga itself. Provider may or may not honor it.
   */
  readonly contribuinte: DadosContribuinte;
  /**
   * URL Stripe redirects to after payment. Use `{CHECKOUT_SESSION_ID}`
   * literal as the placeholder — Stripe substitutes it server-side.
   * Example: `https://eunenem.example/pagina/francisco/sucesso?session_id={CHECKOUT_SESSION_ID}`.
   */
  readonly returnUrl: string;
  /**
   * Optional adapter-opaque metadata bag that the provider will round-trip
   * via the webhook event. Use sparingly — values must be strings, ≤500
   * chars each, ≤50 keys (Stripe limits). Keys reserved by the engine:
   * `idPagamento`, `idIntencaoPagamento`, `idContribuicao` — these are
   * always stamped by the adapter, do NOT pass them here.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CriarSessaoCheckoutResult {
  /** Provider session id — the client-side mountable identifier. */
  readonly sessionId: string;
  /**
   * Client-side secret token that the embedded checkout SDK consumes to
   * mount the iframe. For Stripe: `session.client_secret`. Treat as
   * opaque on our side — never log it.
   */
  readonly clientSecret: string;
  /**
   * Canonical provider-side reference. Persisted on `IntencaoPagamento.externalRef`.
   * For Stripe: same value as `sessionId`. Distinct field name to keep
   * the persistence concern explicit at the boundary.
   */
  readonly externalRef: string;
}

/**
 * Snapshot of the provider session state — what we know about the
 * payment in flight (or just-completed). The webhook is the source of
 * truth for FINAL state transitions; this read serves rendering use-cases
 * (success page) and defensive lookups.
 */
export interface ObterSessaoCheckoutResult {
  readonly sessionId: string;
  readonly externalRef: string;
  /**
   * Coarse status of the session itself (not of the payment):
   *   - `open`: payment not yet submitted (user still on iframe)
   *   - `complete`: payment submitted, may or may not be approved yet
   *   - `expired`: session expired without payment
   */
  readonly status: 'open' | 'complete' | 'expired';
  /**
   * Coarse status of the payment attached to the session (when known):
   *   - `pending`: provider has not yet finalized (Pix awaiting QR scan, etc.)
   *   - `approved`: payment succeeded (webhook either fired or will)
   *   - `rejected`: payment failed (declined card, expired Pix, etc.)
   *   - `unknown`: session not yet attached to a payment, or status unavailable
   */
  readonly paymentStatus: 'pending' | 'approved' | 'rejected' | 'unknown';
  /**
   * Cleartext map of Stripe custom_fields keyed by the field key (e.g.
   * `recadinho`, `nome`). Adapter normalises Stripe's structured field
   * shape into flat string values. Missing or empty fields are omitted.
   */
  readonly customFields: Readonly<Record<string, string>>;
  /** Amount captured (in cents), if the payment has settled. */
  readonly amountTotalCents: MoneyCents | null;
  /** Contribuinte email captured by the session (Stripe collects this). */
  readonly contribuinteEmail: string | null;
  /** Contribuinte name captured (from custom_fields if collected). */
  readonly contribuinteNome: string | null;
}

export interface CheckoutSessionProvider {
  criarSessaoCheckout(input: CriarSessaoCheckoutInput): Promise<CriarSessaoCheckoutResult>;
  obterSessaoCheckout(sessionId: string): Promise<ObterSessaoCheckoutResult | undefined>;
}
