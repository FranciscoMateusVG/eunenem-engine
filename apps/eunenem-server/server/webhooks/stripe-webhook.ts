/**
 * Signature-verified Stripe webhook handler (aperture-24n36 +
 * aperture-1n6u8 archive pipeline).
 *
 * ROUTE: POST /api/webhooks/stripe — mounted by server.tsx BEFORE the
 * SSR catch-all, AFTER the BetterAuth and tRPC mounts.
 *
 * SECURITY DISCIPLINE (why this file exists):
 *
 *   Legacy eunenem (mini:~/projects/eunenem/.../webhooks/checkout) reads
 *   `await req.json()`, pulls `id`, and trusts whatever arrives. Anyone
 *   who can POST to that URL can mark any pagamento approved.
 *
 *   We explicitly do NOT copy that. Every event MUST be verified via
 *   `stripe.webhooks.constructEvent(rawBody, sigHeader, webhookSecret)`
 *   BEFORE the payload is read for dispatch. The raw body must be the
 *   exact bytes Stripe signed — `c.req.text()` is the only safe reader;
 *   `c.req.json()` would round-trip through JS object semantics and
 *   change the byte representation, breaking the HMAC.
 *
 *   On verification failure we return 400 with a GENERIC body
 *   ("signature mismatch") — never echo the SDK error message back to
 *   the client. The SDK's error sometimes mentions which check failed
 *   (timestamp tolerance, signature format, etc.) — that's an oracle
 *   for someone fuzzing the endpoint. Log it internally instead.
 *
 *   Stripe interprets ANY non-2xx as "retry this event later." So we
 *   return 200 on every successfully-verified event including no-ops,
 *   and reserve 5xx for actual downstream failures (e.g.
 *   finalizarPagamentoAprovado throws → 500 → Stripe retries with
 *   exponential backoff).
 *
 * ARCHIVE PIPELINE (aperture-1n6u8):
 *
 *   The archive + verify + dispatch coordination lives in
 *   `archiveAndDispatchStripeEvent` (engine: src/adapters/webhook-archive/
 *   stripe-webhook-pipeline.ts). That pure function:
 *
 *     1. Parses JSON to extract event.id + event.type. Malformed JSON →
 *        400, no archive row.
 *     2. Verifies the signature against the raw body. Result becomes
 *        signature_valid in the archive row.
 *     3. Writes the archive row BEFORE dispatching domain side effects.
 *        Failed-signature events still get a row (forensic evidence of
 *        attack attempts) with signature_valid=false. Retries
 *        (ON CONFLICT on (provider, provider_event_id)) short-circuit
 *        to 200 — Stripe stops retrying without re-dispatching.
 *     4. On valid signature, calls the dispatch callback (this file's
 *        `dispatchVerifiedStripeEvent`). On success, markProcessed +
 *        200. On exception, markFailed + 500.
 *
 *   The Hono handler below is dumb glue: pull raw body + signature,
 *   call the pipeline, translate the result to a Response.
 *
 * LOCAL DEV WORKFLOW:
 *
 *   In a separate terminal:
 *     $ stripe listen --forward-to localhost:3001/api/webhooks/stripe
 *     > Ready! Your webhook signing secret is whsec_xxx (...)
 *
 *   Paste the whsec_xxx into apps/eunenem-server/.env as
 *   STRIPE_WEBHOOK_SECRET, then restart the dev server.
 *
 *   Trigger test events:
 *     $ stripe trigger checkout.session.completed
 *     $ stripe trigger checkout.session.expired
 *     $ stripe trigger payment_intent.payment_failed
 *
 * EVENT DISPATCH TABLE (plan 0015 Phase 3 / aperture-ndxuf — 5-state FSM):
 *
 *   checkout.session.completed
 *     (Stripe Checkout.Session.PaymentStatus enum = 'no_payment_required'
 *      | 'paid' | 'unpaid' — there is NO 'processing' member.)
 *     payment_status='paid'         → finalizarPagamentoAprovado + contribuinte
 *                                     write (card flow; charge already settled)
 *     payment_status='unpaid'       → iniciarProcessamentoPagamento + contribuinte
 *                                     write (pix delayed-notification; Stripe
 *                                     reports 'unpaid' while bank settlement is
 *                                     pending — charge.succeeded finalizes later)
 *     payment_status='no_payment_required' (or any unmodeled future member)
 *                                   → log unhandled_payment_status + no-op
 *   checkout.session.expired        → finalizarPagamentoRejeitado
 *   payment_intent.created          → no transition (audit only; pagamento linked)
 *   payment_intent.processing       → iniciarProcessamentoPagamento
 *   payment_intent.succeeded        → no transition (link-only; persist ch ref)
 *   payment_intent.payment_failed   → finalizarPagamentoRejeitado
 *                                     (pendente|processing → rejeitado)
 *   charge.succeeded                → finalizarPagamentoAprovado
 *                                     (pendente|processing → aprovado;
 *                                     idempotent if already aprovado from cs)
 *   charge.failed                   → finalizarPagamentoRejeitado
 *   charge.updated                  → no transition (audit only) +
 *                                     aperture-8qknw retry of
 *                                     available_on resolution when
 *                                     cs.completed got null from Stripe
 *                                     (balance_transaction race)
 *   charge.refunded (FULL)          → estornarPagamento (aprovado → estornado)
 *   charge.refunded (partial)       → no transition (stays aprovado per
 *                                     plan 0015 locked decision #7)
 *   charge.dispute.created          → no transition (out-of-scope; audit only;
 *                                     pagamento linked for forensic trail)
 *   (anything else)                 → log info + 200 no-op
 *
 *   `checkout.session.*` events carry the session id in
 *   `event.data.object.id` — we resolve via
 *   `pagamentoRepository.findByExternalRef(id)` (the externalRef stamped
 *   on Pagamento creation is the Stripe session id; aperture-xaha2).
 *
 *   `payment_intent.payment_failed` does NOT carry a session id in the
 *   payload — Stripe doesn't backlink PI → Session in the webhook body.
 *   We work around it by reading `metadata.idPagamento` (we stamp
 *   idPagamento onto the session metadata at create time — see
 *   `provider.stripe.ts` line ~170; it propagates to the PI). If
 *   metadata is missing we log + 200 (don't crash the webhook handler
 *   over a stripe-side change in PI payload shape).
 */
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context } from 'hono';
import type Stripe from 'stripe';
import {
  archiveAndDispatchStripeEvent,
  estornarPagamento,
  finalizarPagamentoAprovado,
  finalizarPagamentoRejeitado,
  IdPagamentoSchema,
  iniciarProcessamentoPagamento,
  PagamentoEstornoLancamentoJaTransferidoError,
} from '../../../../src/index.js';
import type { ServerDeps } from '../auth/setup.js';
import { getStripe } from '../../src/lib/stripe/stripe.js';

const tracer = trace.getTracer('eunenem-server');

/**
 * Pull contribuinte (nome + email + optional mensagem/recadinho) from a
 * Stripe Checkout Session payload (aperture-m95f3).
 *
 * Stripe surfaces the visitor's data in three places:
 *   - `customer_details.email` — Stripe-native field, set by
 *     `customer_creation: 'if_required'`. The receipt also lands here.
 *   - `custom_fields[key=nome]` — required field configured in the
 *     embedded UI by provider.stripe.ts.
 *   - `custom_fields[key=mensagem]` — optional recadinho.
 *
 * Returns `undefined` if either nome or email is missing — the contribuinte
 * VO requires both. In that case the finalize still proceeds (just without
 * the association); operator alerted via the `webhook.stripe.contribuinte_missing`
 * log emission below.
 */
function extractContribuinteFromSession(
  session: Stripe.Checkout.Session,
): { nome: string; email: string; mensagem?: string } | undefined {
  const email = session.customer_details?.email ?? session.customer_email ?? null;
  const customFields = session.custom_fields ?? [];
  const nomeField = customFields.find((f) => f.key === 'nome');
  const mensagemField = customFields.find((f) => f.key === 'mensagem');
  const nome = nomeField?.text?.value?.trim() ?? '';
  const mensagem = mensagemField?.text?.value?.trim() ?? '';

  if (nome.length === 0 || !email || email.length === 0) {
    return undefined;
  }

  return {
    nome,
    email,
    ...(mensagem.length > 0 ? { mensagem } : {}),
  };
}

/**
 * Builds the webhook handler closed over `deps`. Returned as a Hono
 * handler so server.tsx can mount it directly.
 */
export function createStripeWebhookHandler(deps: ServerDeps) {
  return async (c: Context): Promise<Response> => {
    return tracer.startActiveSpan('webhook.stripe', async (span) => {
      const { logger } = deps.observability;

      try {
        // 1. RAW BODY — c.req.text() is the only safe reader for sig
        // verification. c.req.json() would corrupt the bytes the HMAC
        // was computed against.
        const rawBody = await c.req.text();

        // 2. SIGNATURE HEADER
        const sig = c.req.header('stripe-signature');
        if (!sig) {
          logger.warn('webhook.stripe.signature_missing', {});
          span.setAttribute('webhook.outcome', 'missing_signature');
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'missing signature' });
          return c.text('signature mismatch', 400);
        }

        // 3. WEBHOOK SECRET — boot validator catches missing secret in
        // production, but double-check at first use.
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret || secret.length === 0) {
          logger.error('webhook.stripe.secret_missing', {});
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'webhook secret not configured' });
          return c.text('webhook not configured', 500);
        }

        // 4. ARCHIVE + VERIFY + DISPATCH (aperture-1n6u8 pipeline). The
        // archive write happens BEFORE signature verification: failed-
        // signature events still get a row (forensic evidence of attacks).
        // The pipeline handles ON CONFLICT short-circuit (Stripe retries)
        // and marks processed/failed based on the dispatch callback's
        // outcome.
        const result = await archiveAndDispatchStripeEvent(deps.webhookEventArchive, {
          rawBody,
          signatureHeader: sig,
          verifyEvent: (raw, header) =>
            getStripe().webhooks.constructEvent(raw, header, secret),
          dispatch: async (event) => {
            span.setAttribute('webhook.event.id', event.id);
            span.setAttribute('webhook.event.type', event.type);
            logger.info('webhook.stripe.verified', {
              eventId: event.id,
              eventType: event.type,
            });
            return dispatchVerifiedStripeEvent(deps, span, event);
          },
        });

        // 5. Log + span outcome.
        if (result.archiveId) {
          span.setAttribute('webhook.archive.id', result.archiveId);
        }
        span.setAttribute('webhook.outcome', result.outcome);
        switch (result.outcome) {
          case 'signature_failed':
            logger.warn('webhook.stripe.signature_failed', {
              archiveId: result.archiveId ?? null,
            });
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'signature verification failed',
            });
            break;
          case 'duplicate_retry':
            logger.info('webhook.stripe.duplicate_retry', {
              archiveId: result.archiveId ?? null,
            });
            span.setStatus({ code: SpanStatusCode.OK });
            break;
          case 'malformed_body':
            logger.warn('webhook.stripe.malformed_body', {});
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'malformed body' });
            break;
          case 'dispatched_failed':
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'dispatch failed' });
            break;
          default:
            span.setStatus({ code: SpanStatusCode.OK });
            break;
        }

        return c.text(result.body, result.status as 200 | 400 | 500);
      } catch (unexpectedError) {
        // Catch-all for anything that escaped the pipeline (e.g.
        // c.req.text() blew up, archive write blew up at first use).
        // Return 500 so Stripe retries.
        logger.error('webhook.stripe.unexpected_error', {
          error: (unexpectedError as Error).message,
        });
        span.recordException(unexpectedError as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (unexpectedError as Error).message,
        });
        return c.text('internal error', 500);
      } finally {
        span.end();
      }
    });
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Dispatch table — invoked by the pipeline ONLY when signature
//  verification succeeded. Returns the resolved pagamentoId (or null
//  for events that don't map to one); the pipeline writes it to
//  payment_webhook_events.pagamento_id via markProcessed. Exceptions
//  bubble up to the pipeline, which catches them, calls markFailed,
//  and returns 500 to Stripe (so it retries; the retry hits the
//  ON CONFLICT path and the archive row's processing_error is visible
//  for operator inspection).
// ─────────────────────────────────────────────────────────────────────

// Exported for aperture-wif8s tests so the per-event-type resolution
// behaviour can be unit-tested without spinning up Hono. The handler's
// outer shell (createStripeWebhookHandler) is still the only entry
// point used in production wiring.
export async function dispatchVerifiedStripeEvent(
  deps: ServerDeps,
  span: Span,
  event: Stripe.Event,
): Promise<{ pagamentoId: string | null }> {
  const { logger } = deps.observability;

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      let pagamento = await deps.pagamentoRepository.findByExternalRef(session.id);
      if (!pagamento) {
        // Could be a legitimate Stripe replay for a session we
        // never created (e.g. another integration sharing the
        // same Stripe account). Don't 404 — Stripe would retry.
        logger.info('webhook.stripe.unknown_session', {
          eventId: event.id,
          eventType: event.type,
          sessionId: session.id,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);

      // aperture-wif8s: persist the pi_xxx reference NOW so subsequent
      // payment_intent.* / charge.* events can resolve back to this
      // pagamento via the new findByPaymentIntentExternalRef port.
      // session.payment_intent can be a string OR an expanded object;
      // we only need the id.
      //
      // aperture-1ewwh: also resolve balanceTransactionAvailableOn here
      // when piId is known and the pagamento still has it NULL. The
      // pi.succeeded dispatcher branch ALSO handles this path, but
      // Stripe frequently delivers pi.succeeded BEFORE cs.completed
      // (orphan path) and the pi.succeeded handler bails on
      // `unknown_payment_intent` before any resolution happens — so
      // the relink sweep here is the only place that handles the
      // cs-before-pi-link race AND the retroactive sweep of any
      // already-delivered pi.succeeded that never resolved its
      // available_on. Branches by metodo:
      //   - pix: set availableOn = clock() inline (legacy "no-cancel"
      //     domain shortcut — pix funds settle instantly).
      //   - credit_card: call obterAvailableOnDoPaymentIntent(piId)
      //     which fetches the PI from Stripe with latest_charge.
      //     balance_transaction expanded; returns both chargeRef and
      //     availableOn in one round-trip. Resolves the orphaned case
      //     where chargeExternalRef was never persisted either.
      const piId = extractStripeId(session.payment_intent);
      const piRefNeedsUpdate =
        piId !== null && pagamento.intencao.paymentIntentExternalRef !== piId;

      // Compute available_on + chargeRef updates if still null on pagamento.
      let newChargeRef: string | null = null;
      let chargeRefNeedsUpdate = false;
      let newAvailableOn: Date | null = null;
      let availableOnNeedsUpdate = false;
      if (piId !== null && pagamento.intencao.balanceTransactionAvailableOn === null) {
        if (pagamento.intencao.metodo === 'pix') {
          newAvailableOn = deps.clock();
          availableOnNeedsUpdate = true;
          span.setAttribute('available_on.source', 'cs_pix_now');
        } else if (pagamento.intencao.metodo === 'credit_card') {
          const resolved = await deps.pagamentoProvider.obterAvailableOnDoPaymentIntent(piId);
          newAvailableOn = resolved.availableOn;
          availableOnNeedsUpdate = true;
          if (
            resolved.chargeRef !== null &&
            pagamento.intencao.chargeExternalRef !== resolved.chargeRef
          ) {
            newChargeRef = resolved.chargeRef;
            chargeRefNeedsUpdate = true;
          }
          if (resolved.availableOn === null) {
            logger.warn('webhook.stripe.cs_available_on_unknown', {
              eventId: event.id,
              idPagamento: pagamento.id,
              paymentIntentId: piId,
            });
            span.setAttribute('available_on.source', 'cs_stripe_api_null');
          } else {
            span.setAttribute('available_on.source', 'cs_stripe_api');
            span.setAttribute('available_on.iso', resolved.availableOn.toISOString());
          }
        }
      }

      if (piRefNeedsUpdate || chargeRefNeedsUpdate || availableOnNeedsUpdate) {
        pagamento = {
          ...pagamento,
          intencao: {
            ...pagamento.intencao,
            ...(piRefNeedsUpdate ? { paymentIntentExternalRef: piId } : {}),
            ...(chargeRefNeedsUpdate ? { chargeExternalRef: newChargeRef } : {}),
            ...(availableOnNeedsUpdate ? { balanceTransactionAvailableOn: newAvailableOn } : {}),
          },
          atualizadoEm: deps.clock(),
        };
        await deps.pagamentoRepository.update(pagamento);
        if (piRefNeedsUpdate) {
          logger.info('webhook.stripe.pi_ref_persisted', {
            eventId: event.id,
            idPagamento: pagamento.id,
            paymentIntentId: piId,
          });
        }
        if (chargeRefNeedsUpdate) {
          logger.info('webhook.stripe.cs_ch_ref_persisted', {
            eventId: event.id,
            idPagamento: pagamento.id,
            chargeId: newChargeRef,
          });
        }
        if (availableOnNeedsUpdate) {
          logger.info('webhook.stripe.cs_available_on_persisted', {
            eventId: event.id,
            idPagamento: pagamento.id,
            metodo: pagamento.intencao.metodo,
            availableOn: newAvailableOn?.toISOString() ?? null,
          });
        }
      }

      if (piRefNeedsUpdate && piId !== null) {
        // aperture-v4ax3 retroactive sweep — Stripe frequently delivers
        // payment_intent.* and charge.* events BEFORE the
        // checkout.session.completed event that carries the
        // session→pagamento linkage. Those earlier events archive as
        // orphans (pagamento_id NULL) because the pi-keyed lookup
        // misses (the column was still null at the time). Now that
        // we've populated the pi ref, sweep the archive and stamp
        // pagamento_id onto any orphan rows referencing this pi.
        // Idempotent: the sweep filters on pagamento_id IS NULL, so
        // re-firing is harmless.
        const relinked = await deps.webhookEventArchive.relinkOrphansByPaymentIntent(
          piId,
          pagamento.id,
        );
        if (relinked > 0) {
          logger.info('webhook.stripe.relinked_orphans', {
            eventId: event.id,
            idPagamento: pagamento.id,
            paymentIntentId: piId,
            relinkedCount: relinked,
          });
          span.setAttribute('webhook.relinked.count', relinked);
        }
      }

      // aperture-m95f3 + plan 0015: extract contribuinte data from
      // the Stripe session — Stripe collects nome + mensagem via
      // custom_fields and email via customer_creation.
      const contribuinte = extractContribuinteFromSession(session);

      // Plan 0015 Phase 3 — branch on session.payment_status. Stripe's
      // Checkout.Session.PaymentStatus union is
      // 'no_payment_required' | 'paid' | 'unpaid' (there is no 'processing'
      // member — that's a PaymentIntent status, not a Checkout status):
      //   'paid'   → card flow, charge already settled.
      //              finalizarPagamentoAprovado handles the
      //              pendente|processing → aprovado transition
      //              AND writes contribuinte atomically.
      //   'unpaid' → pix flow (delayed-notification PM). On
      //              checkout.session.completed Stripe reports the session
      //              as 'unpaid' while the bank confirmation is pending:
      //              QR scanned, awaiting settlement. Write contribuinte
      //              directly; transition to processing via
      //              iniciarProcessamentoPagamento. finalize-aprovado fires
      //              later from charge.succeeded / async_payment_succeeded.
      span.setAttribute('checkout.payment_status', session.payment_status ?? 'unknown');
      if (session.payment_status === 'paid') {
        await finalizarPagamentoAprovado(
          {
            pagamentoRepository: deps.pagamentoRepository,
            pagamentoProvider: deps.pagamentoProvider,
            pagamentoEventPublisher: deps.pagamentoEventPublisher,
            contribuicaoRepository: deps.contribuicaoRepository,
            campanhaRepository: deps.campanhaRepository,
            livroFinanceiroRepository: deps.livroFinanceiroRepository,
            clock: deps.clock,
            observability: deps.observability,
          },
          {
            idPagamento: pagamento.id,
            ...(contribuinte ? { contribuinte } : {}),
          },
        );
        logger.info('webhook.stripe.dispatched', {
          eventId: event.id,
          eventType: event.type,
          idPagamento: pagamento.id,
          transition: 'aprovado',
          paymentStatus: 'paid',
        });
      } else if (session.payment_status === 'unpaid') {
        // Write contribuinte first (first-writer-wins) — finalize-aprovado
        // isn't being called yet, so its own contribuinte-write logic
        // doesn't fire. When charge.succeeded later triggers finalize-aprovado,
        // it sees contribuinte already set and skips its write.
        if (contribuinte && pagamento.intencao.contribuinte === null) {
          pagamento = {
            ...pagamento,
            intencao: { ...pagamento.intencao, contribuinte },
            atualizadoEm: deps.clock(),
          };
          await deps.pagamentoRepository.update(pagamento);
          logger.info('webhook.stripe.contribuinte_stamped', {
            eventId: event.id,
            idPagamento: pagamento.id,
          });
        }
        // pendente → processing. Idempotent on processing → processing.
        if (pagamento.status === 'pendente') {
          pagamento = iniciarProcessamentoPagamento(pagamento, deps.clock());
          await deps.pagamentoRepository.update(pagamento);
        }
        logger.info('webhook.stripe.dispatched', {
          eventId: event.id,
          eventType: event.type,
          idPagamento: pagamento.id,
          transition: 'processing',
          paymentStatus: 'processing',
        });
      } else {
        // payment_status === 'no_payment_required' (zero-amount session) or
        // any future member we don't model. Neither 'paid' nor 'unpaid', so
        // there's no FSM transition to make — log + no-op so the operator can
        // investigate without us forcing a transition.
        logger.info('webhook.stripe.unhandled_payment_status', {
          eventId: event.id,
          eventType: event.type,
          idPagamento: pagamento.id,
          paymentStatus: session.payment_status ?? 'unknown',
        });
      }
      return { pagamentoId: pagamento.id };
    }

    // payment_intent.created — no transition (audit only).
    case 'payment_intent.created': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const pagamento = await resolvePagamentoFromPaymentIntent(deps, pi);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_payment_intent', {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId: pi.id,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
      });
      return { pagamentoId: pagamento.id };
    }

    // payment_intent.succeeded — no FSM transition (charge.succeeded is
    // canonical for the aprovado transition); link-only + persist
    // ch_xxx ref so charge.* events can resolve via the ch path.
    //
    // Plan 0015 / aperture-mjgxe — ALSO populate
    // intencao.balanceTransactionAvailableOn here so the admin DTO can
    // derive the liberação sub-state:
    //   - PIX: set to NOW() inline (operator's no-cancel domain shortcut)
    //   - CARTÃO: fetch via PagamentoProvider.obterAvailableOnDoCharge
    //     (Stripe API charge.balance_transaction.available_on). If the
    //     API call returns null (transient failure, no balance_transaction
    //     yet), persist NULL and log; admin can inspect Stripe directly.
    //
    // The new column is updated atomically with the ch ref so a single
    // pagamentoRepository.update() carries both writes.
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      let pagamento = await resolvePagamentoFromPaymentIntent(deps, pi);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_payment_intent', {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId: pi.id,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);

      // ch_xxx persistence (existing wif8s logic) + plan-0015 availableOn
      // resolution. We collapse both writes into one update() call so the
      // pagamento snapshot stays atomic.
      const chId = extractStripeId(pi.latest_charge);
      const newChRef =
        chId !== null && pagamento.intencao.chargeExternalRef !== chId ? chId : null;

      let newAvailableOn: Date | null = null;
      let availableOnNeedsUpdate = false;
      if (pagamento.intencao.balanceTransactionAvailableOn === null) {
        if (pagamento.intencao.metodo === 'pix') {
          newAvailableOn = deps.clock();
          availableOnNeedsUpdate = true;
          span.setAttribute('available_on.source', 'pix_now');
        } else if (pagamento.intencao.metodo === 'credit_card') {
          // Need a charge id to look up balance_transaction. Prefer the
          // freshly-extracted chId (current event); fall back to the
          // existing chargeExternalRef on the pagamento (defensive — pi
          // can re-fire without latest_charge in rare paths).
          const lookupChRef = chId ?? pagamento.intencao.chargeExternalRef;
          if (lookupChRef !== null) {
            const fetched = await deps.pagamentoProvider.obterAvailableOnDoCharge(lookupChRef);
            newAvailableOn = fetched;
            availableOnNeedsUpdate = true;
            if (fetched === null) {
              logger.warn('webhook.stripe.available_on_unknown', {
                eventId: event.id,
                idPagamento: pagamento.id,
                chargeId: lookupChRef,
              });
              span.setAttribute('available_on.source', 'stripe_api_null');
            } else {
              span.setAttribute('available_on.source', 'stripe_api');
              span.setAttribute('available_on.iso', fetched.toISOString());
            }
          } else {
            logger.warn('webhook.stripe.available_on_no_charge_ref', {
              eventId: event.id,
              idPagamento: pagamento.id,
            });
          }
        }
      }

      if (newChRef !== null || availableOnNeedsUpdate) {
        pagamento = {
          ...pagamento,
          intencao: {
            ...pagamento.intencao,
            ...(newChRef !== null ? { chargeExternalRef: newChRef } : {}),
            ...(availableOnNeedsUpdate ? { balanceTransactionAvailableOn: newAvailableOn } : {}),
          },
          atualizadoEm: deps.clock(),
        };
        await deps.pagamentoRepository.update(pagamento);
        if (newChRef !== null) {
          logger.info('webhook.stripe.ch_ref_persisted', {
            eventId: event.id,
            idPagamento: pagamento.id,
            chargeId: newChRef,
          });
        }
        if (availableOnNeedsUpdate) {
          logger.info('webhook.stripe.available_on_persisted', {
            eventId: event.id,
            idPagamento: pagamento.id,
            metodo: pagamento.intencao.metodo,
            availableOn: newAvailableOn?.toISOString() ?? null,
          });
        }
      }

      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
      });
      return { pagamentoId: pagamento.id };
    }

    // payment_intent.processing — Plan 0015 Phase 3: pendente → processing.
    // Pix flow signal that the QR was scanned / ACH float started.
    // Idempotent on processing → processing. Other source states are
    // no-ops (already-aprovado / already-rejeitado / already-estornado).
    case 'payment_intent.processing': {
      const pi = event.data.object as Stripe.PaymentIntent;
      let pagamento = await resolvePagamentoFromPaymentIntent(deps, pi);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_payment_intent', {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId: pi.id,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      if (pagamento.status === 'pendente') {
        pagamento = iniciarProcessamentoPagamento(pagamento, deps.clock());
        await deps.pagamentoRepository.update(pagamento);
        logger.info('webhook.stripe.dispatched', {
          eventId: event.id,
          eventType: event.type,
          idPagamento: pagamento.id,
          transition: 'processing',
        });
      } else {
        logger.info('webhook.stripe.processing_skipped', {
          eventId: event.id,
          eventType: event.type,
          idPagamento: pagamento.id,
          currentStatus: pagamento.status,
        });
      }
      return { pagamentoId: pagamento.id };
    }

    // charge.succeeded — Plan 0015 Phase 3: pendente|processing → aprovado.
    // Canonical transition for the aprovado path. For card flows it's
    // idempotent (already aprovado via cs.completed); for pix flows
    // it's the first-time transition (cs.completed only got us to
    // processing). Contribuinte was already written during cs.completed
    // (for both flows); finalize-aprovado's first-writer-wins skip
    // protects against overwrites.
    case 'charge.succeeded': {
      const charge = event.data.object as Stripe.Charge;
      const pagamento = await resolvePagamentoFromCharge(deps, charge);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_charge', {
          eventId: event.id,
          eventType: event.type,
          chargeId: charge.id,
          paymentIntentId: extractStripeId(charge.payment_intent),
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      // Skip if already terminal (aprovado/estornado/rejeitado) — only
      // re-fire the finalize path for source states that can still
      // legally transition. finalize-aprovado has its own replay
      // idempotency on aprovado, but skipping at the dispatcher saves
      // the round-trip + makes the log signal clearer.
      if (
        pagamento.status === 'aprovado' ||
        pagamento.status === 'estornado' ||
        pagamento.status === 'rejeitado'
      ) {
        logger.info('webhook.stripe.charge_succeeded_terminal', {
          eventId: event.id,
          idPagamento: pagamento.id,
          currentStatus: pagamento.status,
        });
        return { pagamentoId: pagamento.id };
      }
      await finalizarPagamentoAprovado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pagamentoProvider: deps.pagamentoProvider,
          pagamentoEventPublisher: deps.pagamentoEventPublisher,
          contribuicaoRepository: deps.contribuicaoRepository,
          campanhaRepository: deps.campanhaRepository,
          livroFinanceiroRepository: deps.livroFinanceiroRepository,
          clock: deps.clock,
          observability: deps.observability,
        },
        { idPagamento: pagamento.id },
      );
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
        transition: 'aprovado',
      });
      return { pagamentoId: pagamento.id };
    }

    // charge.failed — Plan 0015 Phase 3: pendente|processing → rejeitado.
    case 'charge.failed': {
      const charge = event.data.object as Stripe.Charge;
      const pagamento = await resolvePagamentoFromCharge(deps, charge);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_charge', {
          eventId: event.id,
          eventType: event.type,
          chargeId: charge.id,
          paymentIntentId: extractStripeId(charge.payment_intent),
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      if (
        pagamento.status === 'aprovado' ||
        pagamento.status === 'estornado' ||
        pagamento.status === 'rejeitado'
      ) {
        logger.info('webhook.stripe.charge_failed_terminal', {
          eventId: event.id,
          idPagamento: pagamento.id,
          currentStatus: pagamento.status,
        });
        return { pagamentoId: pagamento.id };
      }
      await finalizarPagamentoRejeitado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pagamentoProvider: deps.pagamentoProvider,
          pagamentoEventPublisher: deps.pagamentoEventPublisher,
          contribuicaoRepository: deps.contribuicaoRepository,
          campanhaRepository: deps.campanhaRepository,
          clock: deps.clock,
          observability: deps.observability,
        },
        { idPagamento: pagamento.id },
      );
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
        transition: 'rejeitado',
      });
      return { pagamentoId: pagamento.id };
    }

    // charge.refunded — Plan 0015 Phase 3: aprovado → estornado on FULL
    // refunds only (amount_refunded === amount). Partial refunds keep
    // the pagamento aprovado per locked decision #7. The estorno gate
    // (no transferred lançamentos) lives in the use-case; if Stripe
    // refunded but our admin already marked transferred, the use-case
    // throws and we 500 → Stripe retries (which won't help — operator
    // must investigate). That's an acceptable signal of state drift.
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const pagamento = await resolvePagamentoFromCharge(deps, charge);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_charge', {
          eventId: event.id,
          eventType: event.type,
          chargeId: charge.id,
          paymentIntentId: extractStripeId(charge.payment_intent),
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      const amountRefunded = charge.amount_refunded ?? 0;
      const amountTotal = charge.amount ?? 0;
      const isFullRefund = amountTotal > 0 && amountRefunded === amountTotal;
      span.setAttribute('refund.amount_refunded', amountRefunded);
      span.setAttribute('refund.amount_total', amountTotal);
      span.setAttribute('refund.full', isFullRefund);
      if (!isFullRefund) {
        logger.info('webhook.stripe.charge_partial_refund', {
          eventId: event.id,
          idPagamento: pagamento.id,
          amountRefunded,
          amountTotal,
        });
        return { pagamentoId: pagamento.id };
      }
      // Idempotent on already-estornado (estornarPagamento handles it).
      if (pagamento.status === 'estornado') {
        logger.info('webhook.stripe.charge_refund_already_estornado', {
          eventId: event.id,
          idPagamento: pagamento.id,
        });
        return { pagamentoId: pagamento.id };
      }
      // Webhook-driven full refund — call the estornar use-case. The
      // use-case still runs the 409 gate; if any lançamento has been
      // transferred, the gate throws PagamentoEstornoLancamentoJaTransferidoError
      // and the webhook surfaces 500 (Stripe retries). This is the
      // right signal for the operator that state has drifted —
      // Stripe says refunded, our admin says transferred — and
      // resolution requires manual investigation.
      try {
        await estornarPagamento(
          {
            pagamentoRepository: deps.pagamentoRepository,
            pagamentoProvider: deps.pagamentoProvider,
            pagamentoEventPublisher: deps.pagamentoEventPublisher,
            livroFinanceiroRepository: deps.livroFinanceiroRepository,
            clock: deps.clock,
            observability: deps.observability,
          },
          { idPagamento: pagamento.id },
        );
      } catch (estornoError) {
        if (estornoError instanceof PagamentoEstornoLancamentoJaTransferidoError) {
          logger.error('webhook.stripe.charge_refund_409_state_drift', {
            eventId: event.id,
            idPagamento: pagamento.id,
            note: 'Stripe says refunded; engine says at least one lançamento was already transferred to recebedor. Manual investigation required.',
          });
        }
        throw estornoError;
      }
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
        transition: 'estornado',
      });
      return { pagamentoId: pagamento.id };
    }

    // charge.updated — no FSM transition (audit only). Stripe fires this
    // for partial refund signaling, dispute updates, metadata changes,
    // AND — critically for aperture-8qknw — to backfill
    // `balance_transaction.available_on` once Stripe's internal accounting
    // settles. At cs.completed time the balance_transaction may exist but
    // available_on is often still null (race with Stripe internals);
    // charge.updated fires 1-2s later with the field fully populated.
    //
    // aperture-8qknw retry: when metodo='credit_card' AND the pagamento
    // still has `balanceTransactionAvailableOn=null`, re-call the
    // Stripe API and persist whatever we get. Idempotent on null →
    // re-firing is harmless. Once populated, the predicate short-
    // circuits and the row never gets a second fetch.
    case 'charge.updated': {
      let charge = event.data.object as Stripe.Charge;
      let pagamento = await resolvePagamentoFromCharge(deps, charge);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_charge', {
          eventId: event.id,
          eventType: event.type,
          chargeId: charge.id,
          paymentIntentId: extractStripeId(charge.payment_intent),
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);

      // aperture-8qknw — retroactive available_on resolution.
      if (
        pagamento.intencao.metodo === 'credit_card' &&
        pagamento.intencao.balanceTransactionAvailableOn === null
      ) {
        // Prefer the charge.id from the event (always present on
        // charge.updated); fall back to the persisted chargeExternalRef.
        const chargeRef =
          typeof charge.id === 'string' && charge.id.length > 0
            ? charge.id
            : pagamento.intencao.chargeExternalRef;
        if (chargeRef !== null) {
          const fetched = await deps.pagamentoProvider.obterAvailableOnDoCharge(chargeRef);
          // Persist whatever we got (including null, since the schema
          // allows it). The idempotency check above means we won't
          // re-fetch on subsequent charge.updated events once non-null.
          pagamento = {
            ...pagamento,
            intencao: {
              ...pagamento.intencao,
              balanceTransactionAvailableOn: fetched,
              // chargeExternalRef may still be null if cs.completed
              // didn't carry it (rare edge); persist now for parity
              // with cs.completed's atomic 3-write.
              ...(pagamento.intencao.chargeExternalRef === null && chargeRef !== null
                ? { chargeExternalRef: chargeRef }
                : {}),
            },
            atualizadoEm: deps.clock(),
          };
          await deps.pagamentoRepository.update(pagamento);
          if (fetched === null) {
            logger.warn('webhook.stripe.cu_available_on_unknown', {
              eventId: event.id,
              idPagamento: pagamento.id,
              chargeId: chargeRef,
            });
            span.setAttribute('available_on.source', 'cu_stripe_api_null');
          } else {
            logger.info('webhook.stripe.cu_available_on_persisted', {
              eventId: event.id,
              idPagamento: pagamento.id,
              metodo: 'credit_card',
              availableOn: fetched.toISOString(),
            });
            span.setAttribute('available_on.source', 'cu_stripe_api');
            span.setAttribute('available_on.iso', fetched.toISOString());
          }
        } else {
          logger.warn('webhook.stripe.cu_available_on_no_charge_ref', {
            eventId: event.id,
            idPagamento: pagamento.id,
          });
        }
      }

      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
      });
      return { pagamentoId: pagamento.id };
    }

    // charge.dispute.created — Plan 0015 Phase 3: out-of-scope (locked
    // decision #12). No transition; pagamento stays aprovado. We
    // resolve via charge id for the audit-trail link and log at warn
    // level so operators see the dispute in their dashboards. Full
    // dispute handling (notify recebedor, reverse already-transferred
    // lançamentos, mark `disputed` state) is a follow-up bead.
    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute;
      const chargeId = extractStripeId(dispute.charge);
      if (!chargeId) {
        logger.warn('webhook.stripe.dispute_missing_charge', {
          eventId: event.id,
          eventType: event.type,
        });
        return { pagamentoId: null };
      }
      const pagamento = await deps.pagamentoRepository.findByChargeExternalRef(chargeId);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_charge', {
          eventId: event.id,
          eventType: event.type,
          chargeId,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      logger.warn('webhook.stripe.dispute_created', {
        eventId: event.id,
        idPagamento: pagamento.id,
        chargeId,
        amount: dispute.amount,
        reason: dispute.reason,
      });
      return { pagamentoId: pagamento.id };
    }

    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const pagamento = await deps.pagamentoRepository.findByExternalRef(session.id);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_session', {
          eventId: event.id,
          eventType: event.type,
          sessionId: session.id,
        });
        return { pagamentoId: null };
      }
      span.setAttribute('pagamento.id', pagamento.id);
      await finalizarPagamentoRejeitado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pagamentoProvider: deps.pagamentoProvider,
          pagamentoEventPublisher: deps.pagamentoEventPublisher,
          contribuicaoRepository: deps.contribuicaoRepository,
          campanhaRepository: deps.campanhaRepository,
          clock: deps.clock,
          observability: deps.observability,
        },
        { idPagamento: pagamento.id },
      );
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
      });
      return { pagamentoId: pagamento.id };
    }

    case 'payment_intent.payment_failed': {
      // aperture-wif8s: prefer pi-keyed lookup (matches the new
      // resolver pattern for all payment_intent.* events). Fall back
      // to the legacy metadata-based path when pi lookup misses —
      // covers the edge case where payment_intent.payment_failed
      // arrives BEFORE checkout.session.completed populated the pi
      // ref (rare Stripe webhook reordering).
      const pi = event.data.object as Stripe.PaymentIntent;
      let pagamento = await resolvePagamentoFromPaymentIntent(deps, pi);
      if (!pagamento) {
        // Legacy fallback: metadata.idPagamento stamped at session
        // create time in provider.stripe.ts. Useful when the pi has
        // not yet been bound to a pagamento via the cs.completed
        // path (the ordering edge case).
        const rawIdPagamento = pi.metadata?.idPagamento;
        if (!rawIdPagamento) {
          logger.info('webhook.stripe.unknown_payment_intent', {
            eventId: event.id,
            eventType: event.type,
            paymentIntentId: pi.id,
          });
          return { pagamentoId: null };
        }
        const parsedIdPagamento = IdPagamentoSchema.safeParse(rawIdPagamento);
        if (!parsedIdPagamento.success) {
          logger.warn('webhook.stripe.malformed_metadata', {
            eventId: event.id,
            eventType: event.type,
            paymentIntentId: pi.id,
          });
          return { pagamentoId: null };
        }
        const idPagamento = parsedIdPagamento.data;
        pagamento = await deps.pagamentoRepository.findById(idPagamento);
        if (!pagamento) {
          logger.info('webhook.stripe.unknown_pagamento', {
            eventId: event.id,
            eventType: event.type,
            paymentIntentId: pi.id,
            idPagamento,
          });
          return { pagamentoId: null };
        }
      }
      span.setAttribute('pagamento.id', pagamento.id);
      await finalizarPagamentoRejeitado(
        {
          pagamentoRepository: deps.pagamentoRepository,
          pagamentoProvider: deps.pagamentoProvider,
          pagamentoEventPublisher: deps.pagamentoEventPublisher,
          contribuicaoRepository: deps.contribuicaoRepository,
          campanhaRepository: deps.campanhaRepository,
          clock: deps.clock,
          observability: deps.observability,
        },
        { idPagamento: pagamento.id },
      );
      logger.info('webhook.stripe.dispatched', {
        eventId: event.id,
        eventType: event.type,
        idPagamento: pagamento.id,
      });
      return { pagamentoId: pagamento.id };
    }

    default: {
      logger.info('webhook.stripe.unknown_event', {
        eventId: event.id,
        eventType: event.type,
      });
      return { pagamentoId: null };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
//  aperture-wif8s helpers — pi_xxx + ch_xxx resolution + persistence.
// ─────────────────────────────────────────────────────────────────────

/**
 * Stripe API surfaces some fields as either a bare string id OR an
 * expanded sub-object (depending on the API request's `expand`). The
 * webhook payload typically carries strings, but the SDK types model
 * both. This helper normalises to "the string id we care about" so
 * the resolver doesn't need expand-vs-bare branches everywhere.
 *
 * Returns null when the field is missing OR carries an unexpected
 * shape — caller logs + treats as "not resolvable" (which archives
 * the event as orphan, the right outcome).
 */
function extractStripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

/**
 * Resolve a Pagamento from a Stripe PaymentIntent event payload via
 * the new pi_xxx-keyed port. Returns undefined when the pi hasn't
 * been bound yet (rare ordering edge case — handler archives as
 * orphan). The PaymentIntent's `id` field IS the pi_xxx string.
 */
async function resolvePagamentoFromPaymentIntent(
  deps: ServerDeps,
  pi: Stripe.PaymentIntent,
): Promise<import('../../../../src/index.js').Pagamento | undefined> {
  if (typeof pi.id !== 'string' || pi.id.length === 0) return undefined;
  return deps.pagamentoRepository.findByPaymentIntentExternalRef(pi.id);
}

/**
 * Resolve a Pagamento from a Stripe Charge event payload. Primary:
 * lookup via the parent payment_intent ref (charge.payment_intent
 * carries pi_xxx). Fallback: lookup via the charge id itself (when
 * the pi ref hasn't been backfilled — handles the post-backfill
 * re-process case). Returns undefined when neither resolves.
 */
async function resolvePagamentoFromCharge(
  deps: ServerDeps,
  charge: Stripe.Charge,
): Promise<import('../../../../src/index.js').Pagamento | undefined> {
  const piId = extractStripeId(charge.payment_intent);
  if (piId !== null) {
    const viaPi = await deps.pagamentoRepository.findByPaymentIntentExternalRef(piId);
    if (viaPi) return viaPi;
  }
  if (typeof charge.id === 'string' && charge.id.length > 0) {
    const viaCh = await deps.pagamentoRepository.findByChargeExternalRef(charge.id);
    if (viaCh) return viaCh;
  }
  return undefined;
}
