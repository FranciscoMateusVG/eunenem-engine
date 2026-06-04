import { SpanStatusCode, trace } from '@opentelemetry/api';
import type Stripe from 'stripe';
import type { MoneyCents } from '../../domain/money.js';
import {
  type TransacaoExterna,
  TransacaoExternaSchema,
} from '../../domain/pagamentos/entities/pagamento.js';
import {
  type IdTransacaoExterna,
  IdTransacaoExternaSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import { SURCHARGE_LINE_ITEM_NAME } from './card-surcharge.js';
import type {
  CheckoutSessionProvider,
  CriarSessaoCheckoutInput,
  CriarSessaoCheckoutResult,
  ObterSessaoCheckoutResult,
} from './checkout-session-provider.js';
import type {
  PagamentoProvider,
  RefundarPagamentoInput,
  RefundarPagamentoResult,
  SolicitarPagamentoInput,
} from './provider.js';

const tracer = trace.getTracer('frame');

/**
 * Currency hardcoded BRL — this engine + plataforma serve a single locale.
 * Multi-currency is a future evolution that would require Money to carry
 * currency, not just cents. Out of scope for aperture-xaha2.
 */
const CURRENCY = 'brl' as const;

/**
 * Pix session expiry — mirrors legacy eunenem (10 min). Stripe's default
 * Pix expiry is shorter than card/wallet sessions; 600s is generous
 * enough for a real visitor to scan the QR but tight enough that an
 * abandoned session doesn't sit reserving the contribuicao indefinitely.
 */
const PIX_EXPIRES_AFTER_SECONDS = 600 as const;

/**
 * v1 NOTE — card surcharge handling:
 * Legacy eunenem adds a "Taxa de processamento do cartão" line item for
 * card payments using formula `ceil((base * 0.039) / (1 - 0.039))` (3.9%
 * gross-up so the buyer covers Stripe's processing fee). We are NOT
 * shipping that in v1 — the buyer pays exactly `composicaoValores.totalPaidCents`
 * and the 3.9% Stripe cost eats into our platform fee margin. A follow-up
 * bead will add provider-aware surcharge handling without breaking the
 * PagamentoValorDivergenteError invariant. (Trade-off banked with
 * GLaDOS, 2026-05-30.)
 */

/**
 * Options the constructor accepts. The Stripe SDK instance is injected so
 * tests can stub it without monkey-patching the singleton in lib/stripe/.
 */
export interface PagamentoProviderStripeOptions {
  readonly stripe: Stripe;
  readonly clock?: () => Date;
}

/**
 * Stripe payment-provider adapter (aperture-xaha2). Implements BOTH ports:
 *   - `CheckoutSessionProvider`: pre-session lifecycle used by the visitor
 *     checkout saga (iniciarPagamentoContribuicao). Creates an embedded
 *     `ui_mode='embedded'` checkout session, returns clientSecret for the
 *     frontend to mount.
 *   - `PagamentoProvider`: synchronous approve/reject handshake used by
 *     the webhook-driven finalize path (finalizarPagamentoAprovado →
 *     aprovarPagamento → solicitarPagamento). On Stripe the "transaction"
 *     is already settled by the time the webhook fires — solicitarPagamento
 *     retrieves the session by externalRef and synthesises a TransacaoExterna
 *     from the payment_intent. No new charge happens here; Stripe is the
 *     source of truth for what was paid.
 *
 * **Why one class implements both:** the Pagamento BC's existing
 * finalize-aprovado / finalize-rejeitado use-cases call solicitarPagamento.
 * For Stripe-backed Pagamentos we still want them to flow through that
 * path so the FinanceiroEffects + EventPublisher invariants are unchanged.
 * The synthesise-from-session approach keeps the existing use-cases
 * Stripe-unaware.
 */
export class PagamentoProviderStripe implements PagamentoProvider, CheckoutSessionProvider {
  private readonly stripe: Stripe;
  private readonly clock: () => Date;

  constructor(options: PagamentoProviderStripeOptions) {
    this.stripe = options.stripe;
    this.clock = options.clock ?? (() => new Date());
  }

  // ── CheckoutSessionProvider ────────────────────────────────────────────

  async criarSessaoCheckout(input: CriarSessaoCheckoutInput): Promise<CriarSessaoCheckoutResult> {
    return tracer.startActiveSpan('payment_provider.stripe.criarSessaoCheckout', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.intent.id', input.idIntencaoPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.metodo);
      span.setAttribute('checkout.tipo_opcao', input.tipoOpcao);

      try {
        // Build line items. The visitor picks ONE gift per checkout
        // session, so the gift itself is a single line item. The platform
        // fee (eunenem 10%) is bundled INTO the gift line item — buyer
        // sees an opaque "gift price" that already includes the fee
        // (matches operator's "mirror legacy UX" intent; legacy never
        // surfaced the platform fee to the buyer).
        //
        // When metodo === 'credit_card', a SECOND line item surfaces
        // the Stripe card surcharge (aperture-uyw8i — 3.9% + R$0.39
        // gross-up). Visible to the buyer so they understand why card
        // costs more than Pix; itemised on the receipt for clarity.
        // surchargeCents = 0 for Pix → only the gift line item ships.
        const nonSurchargeAmountCents = (input.amountCents - input.surchargeCents) as MoneyCents;
        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          {
            price_data: {
              currency: CURRENCY,
              product_data: {
                // Verbose name surfaces in Stripe Dashboard for ops debugging.
                // We don't pack ids into the display name (legacy did
                // `"${name} - ${productId}"` and parsed it back — brittle).
                // Identifiers travel in metadata instead.
                name: input.nomeItem,
                metadata: {
                  idContribuicao: input.idContribuicao,
                  idOpcaoContribuicao: input.idOpcaoContribuicao,
                  tipoOpcao: input.tipoOpcao,
                },
              },
              unit_amount: nonSurchargeAmountCents,
            },
            quantity: 1,
          },
        ];
        if (input.surchargeCents > 0) {
          lineItems.push({
            price_data: {
              currency: CURRENCY,
              product_data: {
                name: SURCHARGE_LINE_ITEM_NAME,
              },
              unit_amount: input.surchargeCents,
            },
            quantity: 1,
          });
        }

        // Payment-method shaping. v1 supports card + pix only. Apple/Google
        // Pay deliberately omitted — operator decision.
        // MetodoPagamento enum: 'pix' | 'credit_card'. Map to Stripe's
        // payment_method_types vocabulary.
        const paymentMethodTypes: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
          input.metodo === 'pix'
            ? ['pix']
            : input.metodo === 'credit_card'
              ? ['card']
              : ['card', 'pix'];

        const paymentMethodOptions: Stripe.Checkout.SessionCreateParams.PaymentMethodOptions = {};
        if (paymentMethodTypes.includes('pix')) {
          paymentMethodOptions.pix = { expires_after_seconds: PIX_EXPIRES_AFTER_SECONDS };
        }
        if (paymentMethodTypes.includes('card')) {
          paymentMethodOptions.card = { installments: { enabled: true } };
        }

        // Custom fields Stripe collects in the embedded UI (aperture-m95f3).
        // Both nome AND mensagem (recadinho) are visitor-provided inside the
        // iframe — we don't prefill from upstream state because the upstream
        // no longer collects them (operator: "Stripe is source of truth").
        // Email is collected via `customer_creation: 'if_required'` (Stripe
        // native field, NOT a custom_field — that path also sends Stripe's
        // native receipt email).
        const customFields: Stripe.Checkout.SessionCreateParams.CustomField[] = [
          {
            key: 'nome',
            label: { custom: 'Seu nome', type: 'custom' },
            optional: false,
            text: { maximum_length: 120 },
            type: 'text',
          },
          {
            key: 'mensagem',
            label: { custom: 'Deixe um recadinho (opcional)', type: 'custom' },
            optional: true,
            text: { maximum_length: 255 },
            type: 'text',
          },
        ];

        // Metadata bag round-trips via the webhook event. We stamp the
        // four engine-side ids so the webhook handler can dispatch
        // without re-resolving via the DB; idPagamento is also our
        // findByExternalRef fallback if event payload shape changes.
        const metadata: Stripe.MetadataParam = {
          idPagamento: input.idPagamento,
          idIntencaoPagamento: input.idIntencaoPagamento,
          idContribuicao: input.idContribuicao,
          idOpcaoContribuicao: input.idOpcaoContribuicao,
          tipoOpcao: input.tipoOpcao,
          ...(input.metadata ?? {}),
        };

        // Idempotency: passing idPagamento ensures replays of this
        // create-session call (same idPagamento) return the same session
        // rather than creating a duplicate. Legacy eunenem skipped this —
        // we fix it here.
        // aperture-6g58e: redirect_on_completion threaded from the
        // consumer. 'if_required' lets card+Pix stay inline (Stripe fires
        // onComplete on the iframe) instead of redirecting to return_url —
        // the eunenem inline-success modal depends on this. Default
        // 'always' preserves legacy behavior for any consumer that doesn't
        // opt in.
        const session = await this.stripe.checkout.sessions.create(
          {
            mode: 'payment',
            ui_mode: 'embedded',
            line_items: lineItems,
            payment_method_types: paymentMethodTypes,
            payment_method_options: paymentMethodOptions,
            custom_fields: customFields,
            metadata,
            // aperture-m95f3: native Stripe email collection (sends receipt
            // automatically). NOT customer_email anymore — we no longer
            // know the visitor's email at session-create time. Stripe asks
            // for it in the iframe and stores it on the resulting Customer.
            customer_creation: 'if_required',
            return_url: input.returnUrl,
            redirect_on_completion: input.redirectOnCompletion ?? 'always',
          },
          {
            idempotencyKey: `pagamento:${input.idPagamento}:create-session`,
          },
        );

        if (!session.client_secret) {
          // Stripe ALWAYS returns client_secret for embedded ui_mode
          // sessions — this would be a Stripe API regression. Guard so
          // a future SDK version change surfaces loudly.
          throw new Error(
            `Stripe checkout session ${session.id} returned no client_secret (ui_mode: embedded contract violation).`,
          );
        }

        span.setAttribute('checkout.session.id', session.id);
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          sessionId: session.id,
          clientSecret: session.client_secret,
          externalRef: session.id,
        };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async obterSessaoCheckout(sessionId: string): Promise<ObterSessaoCheckoutResult | undefined> {
    return tracer.startActiveSpan('payment_provider.stripe.obterSessaoCheckout', async (span) => {
      span.setAttribute('checkout.session.id', sessionId);

      try {
        const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent', 'customer_details'],
        });

        // Stripe's `status` enum: 'open' | 'complete' | 'expired' — maps
        // 1:1 to our shape. `payment_status` is the more granular field;
        // we coarsen it for adapter-port boundary purity.
        const status: ObterSessaoCheckoutResult['status'] =
          session.status === 'complete'
            ? 'complete'
            : session.status === 'expired'
              ? 'expired'
              : 'open';

        const paymentStatus: ObterSessaoCheckoutResult['paymentStatus'] =
          session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
            ? 'approved'
            : session.payment_status === 'unpaid' && session.status === 'expired'
              ? 'rejected'
              : session.payment_status === 'unpaid'
                ? 'pending'
                : 'unknown';

        // custom_fields shape: each entry has { key, type, text?: { value } }.
        // Flatten to a key→string map, omitting empty values.
        const customFields: Record<string, string> = {};
        for (const field of session.custom_fields ?? []) {
          const value = field.text?.value?.trim();
          if (value) customFields[field.key] = value;
        }

        const amountTotalCents =
          typeof session.amount_total === 'number' ? (session.amount_total as MoneyCents) : null;

        const contribuinteEmail = session.customer_details?.email ?? session.customer_email ?? null;
        const contribuinteNome = customFields.nome ?? session.customer_details?.name ?? null;

        span.setStatus({ code: SpanStatusCode.OK });
        return {
          sessionId: session.id,
          externalRef: session.id,
          status,
          paymentStatus,
          customFields,
          amountTotalCents,
          contribuinteEmail,
          contribuinteNome,
        };
      } catch (error: unknown) {
        // Stripe SDK throws `Stripe.errors.StripeInvalidRequestError` with
        // code 'resource_missing' when the session id is unknown. Map to
        // undefined per port contract — callers (success page, webhook
        // handler) decide whether that's a 404 or a "stop processing"
        // signal.
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: string }).code === 'resource_missing'
        ) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ── PagamentoProvider (sync approve/reject handshake) ───────────────────

  /**
   * Synthesise a TransacaoExterna from the already-settled Stripe session.
   *
   * Called via aprovarPagamento / rejeitarPagamento from
   * finalizarPagamentoAprovado / finalizarPagamentoRejeitado, both of which
   * are dispatched from the webhook handler. By the time we get here:
   *   - The Stripe session has fired its event (completed / expired / failed)
   *   - The Pagamento aggregate carries externalRef = session.id
   *   - We just need to look up the canonical transaction id (payment_intent)
   *     and produce a TransacaoExterna with the right shape.
   *
   * If externalRef is null, this Pagamento didn't come through the
   * checkout-session flow (somehow it reached the Stripe adapter anyway —
   * shouldn't happen with current wiring) → throw loudly so we notice.
   */
  async solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna> {
    return tracer.startActiveSpan('payment_provider.stripe.solicitarPagamento', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.intent.id', input.idIntencaoPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.metodo);

      try {
        if (!input.externalRef) {
          throw new Error(
            `PagamentoProviderStripe.solicitarPagamento called for pagamento ${input.idPagamento} without externalRef. The Stripe adapter only handles session-backed pagamentos; check DI wiring.`,
          );
        }

        const session = await this.stripe.checkout.sessions.retrieve(input.externalRef, {
          expand: ['payment_intent'],
        });

        // Determine canonical transaction id. For successful sessions,
        // session.payment_intent is either the PI id string or an expanded
        // PI object. For expired / failed sessions, payment_intent may be
        // missing entirely — fall back to the session id so the
        // TransacaoExterna still has an identifier we can correlate.
        let idBruto: string;
        if (typeof session.payment_intent === 'string') {
          idBruto = session.payment_intent;
        } else if (session.payment_intent?.id) {
          idBruto = session.payment_intent.id;
        } else {
          idBruto = session.id;
        }

        const idTransacao = IdTransacaoExternaSchema.parse(idBruto) as IdTransacaoExterna;

        // Status normalisation. Stripe's checkout.session has BOTH `status`
        // (session lifecycle) and `payment_status` (payment outcome). We
        // use payment_status as the authority — it's what tells us "did the
        // money move?"
        const isApproved =
          session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

        const transacao = TransacaoExternaSchema.parse({
          id: idTransacao,
          provedor: 'stripe',
          status: isApproved ? 'aprovado' : 'rejeitado',
          // We trust input.amountCents over session.amount_total here —
          // the Pagamento aggregate's intent is the source of truth for
          // what we expected to charge. session.amount_total should equal
          // input.amountCents in v1 (no surcharge). The downstream
          // finalizarPagamentoAprovado runs PagamentoValorDivergenteError
          // anyway as a defensive check.
          amountCents: input.amountCents,
          criadaEm: this.clock(),
          // Carry the raw Stripe status for ops debugging in spans/logs.
          statusBruto:
            session.payment_status?.slice(0, 120) ?? session.status?.slice(0, 120) ?? 'unknown',
        });

        span.setAttribute('checkout.session.id', session.id);
        span.setAttribute('checkout.payment_status', session.payment_status ?? 'unknown');
        span.setStatus({ code: SpanStatusCode.OK });
        return transacao;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Plan 0015 (aperture-ucgok). Fire a full refund through Stripe Refunds
   * API. The use-case (`estornar-pagamento`) only calls this AFTER the
   * pre-transfer 409 gate has passed; once we get here, the upstream
   * decision to refund is committed.
   *
   * Stripe Refunds API keys off the charge id (`ch_xxx`). The webhook
   * handler populates `chargeExternalRef` on `payment_intent.succeeded`
   * (aperture-wif8s), so it's available by the time an aprovado
   * pagamento becomes refundable. As a fallback, we honor
   * `paymentIntentExternalRef` (`pi_xxx`) — Stripe also accepts the PI
   * as a refund key and will fan it out to the latest charge.
   *
   * Status normalization: Stripe's refund.status is
   * `succeeded | pending | failed | canceled | requires_action`. We
   * collapse `succeeded` AND `pending` to `aceito` (the money path is
   * committed; settlement timing is out-of-band on the provider side)
   * and everything else to `recusado`.
   */
  async refundarPagamento(input: RefundarPagamentoInput): Promise<RefundarPagamentoResult> {
    return tracer.startActiveSpan('payment_provider.stripe.refundarPagamento', async (span) => {
      span.setAttribute('payment.id', input.idPagamento);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('refund.reason', input.reason ?? 'requested_by_customer');
      try {
        if (!input.chargeExternalRef && !input.paymentIntentExternalRef) {
          throw new Error(
            `PagamentoProviderStripe.refundarPagamento called for pagamento ${input.idPagamento} without chargeExternalRef nor paymentIntentExternalRef. Webhook should have populated at least one by aprovado.`,
          );
        }

        const refundParams: Stripe.RefundCreateParams = input.chargeExternalRef
          ? { charge: input.chargeExternalRef, reason: input.reason ?? 'requested_by_customer' }
          : {
              payment_intent: input.paymentIntentExternalRef as string,
              reason: input.reason ?? 'requested_by_customer',
            };

        const refund = await this.stripe.refunds.create(refundParams, {
          idempotencyKey: `pagamento:${input.idPagamento}:refund`,
        });

        const status: RefundarPagamentoResult['status'] =
          refund.status === 'succeeded' || refund.status === 'pending' ? 'aceito' : 'recusado';

        span.setAttribute('refund.id', refund.id);
        span.setAttribute('refund.status', refund.status ?? 'unknown');
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          id: refund.id,
          status,
          amountCents: input.amountCents,
          statusBruto: refund.status?.slice(0, 120) ?? 'unknown',
        };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Plan 0015 / aperture-mjgxe. Look up `charge.balance_transaction.available_on`
   * via Stripe API.
   *
   * Fetches the charge with the balance_transaction expanded. The
   * `available_on` field is a unix seconds timestamp — Stripe's "when
   * funds settle to the platform account." Test mode shows ~6 days
   * out; prod is the configured payout schedule (Stripe Brazil default
   * is ~30 days for unanticipated card payments, instant for pix).
   *
   * Returns `null` when:
   *   - `balance_transaction` is missing on the charge (very-fresh
   *     charges occasionally arrive without it — Stripe's own ordering
   *     edge case)
   *   - the API call fails (network / 5xx / auth)
   *
   * The dispatcher logs a discriminating message on null so operators
   * see WHY available_on stayed unpopulated; admin can manually
   * inspect the charge in Stripe Dashboard if needed.
   */
  async obterAvailableOnDoCharge(chargeRef: string): Promise<Date | null> {
    return tracer.startActiveSpan(
      'payment_provider.stripe.obterAvailableOnDoCharge',
      async (span) => {
        span.setAttribute('charge.ref', chargeRef);
        try {
          const charge = await this.stripe.charges.retrieve(chargeRef, {
            expand: ['balance_transaction'],
          });
          const balanceTransaction = charge.balance_transaction;
          // balance_transaction can be: string (unexpanded id), expanded
          // object, or null/undefined. We requested expand so an object
          // is the happy path; anything else returns null.
          if (
            balanceTransaction === null ||
            balanceTransaction === undefined ||
            typeof balanceTransaction === 'string'
          ) {
            span.setAttribute('balance_transaction.missing', true);
            span.setStatus({ code: SpanStatusCode.OK });
            return null;
          }
          const availableOnUnix = balanceTransaction.available_on;
          if (typeof availableOnUnix !== 'number') {
            span.setAttribute('balance_transaction.available_on.missing', true);
            span.setStatus({ code: SpanStatusCode.OK });
            return null;
          }
          const date = new Date(availableOnUnix * 1000);
          span.setAttribute('available_on.iso', date.toISOString());
          span.setStatus({ code: SpanStatusCode.OK });
          return date;
        } catch (error: unknown) {
          // Same fallback shape as the bead's spec: log + return null
          // so the dispatcher persists NULL on the pagamento; admin can
          // inspect Stripe directly. Don't re-throw — a Stripe outage
          // shouldn't fail the webhook processing of an otherwise-valid
          // payment_intent.succeeded.
          span.recordException(error as Error);
          span.setAttribute('balance_transaction.fetch_failed', true);
          span.setStatus({ code: SpanStatusCode.OK });
          return null;
        } finally {
          span.end();
        }
      },
    );
  }
}
