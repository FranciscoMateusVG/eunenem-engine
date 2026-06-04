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
 *     payment_status='paid'         → finalizarPagamentoAprovado + contribuinte
 *     payment_status='processing'   → iniciarProcessamentoPagamento + contribuinte
 *                                     write (pix QR scanned; settlement pending)
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
 *   charge.updated                  → no transition (audit only)
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
      const piId = extractStripeId(session.payment_intent);
      if (piId !== null && pagamento.intencao.paymentIntentExternalRef !== piId) {
        pagamento = withPaymentIntentRef(pagamento, piId);
        await deps.pagamentoRepository.update(pagamento);
        logger.info('webhook.stripe.pi_ref_persisted', {
          eventId: event.id,
          idPagamento: pagamento.id,
          paymentIntentId: piId,
        });
      }

      // aperture-m95f3 + plan 0015: extract contribuinte data from
      // the Stripe session — Stripe collects nome + mensagem via
      // custom_fields and email via customer_creation.
      const contribuinte = extractContribuinteFromSession(session);

      // Plan 0015 Phase 3 — branch on session.payment_status:
      //   'paid'       → card flow, charge already settled.
      //                  finalizarPagamentoAprovado handles the
      //                  pendente|processing → aprovado transition
      //                  AND writes contribuinte atomically.
      //   'processing' → pix flow, QR scanned, awaiting bank confirmation.
      //                  Write contribuinte directly; transition to
      //                  processing via iniciarProcessamentoPagamento.
      //                  finalize-aprovado fires later from charge.succeeded.
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
      } else if (session.payment_status === 'processing') {
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
        // payment_status === 'unpaid' on a completed session is rare
        // (Stripe usually fires session.expired for unpaid abandonment).
        // Log + no-op so the operator can investigate without us
        // forcing a transition.
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

    // payment_intent.succeeded — no transition (charge.succeeded is
    // canonical); link-only + persist ch_xxx ref so charge.* events
    // can resolve via the ch path.
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
      const chId = extractStripeId(pi.latest_charge);
      if (chId !== null && pagamento.intencao.chargeExternalRef !== chId) {
        pagamento = withChargeRef(pagamento, chId);
        await deps.pagamentoRepository.update(pagamento);
        logger.info('webhook.stripe.ch_ref_persisted', {
          eventId: event.id,
          idPagamento: pagamento.id,
          chargeId: chId,
        });
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

    // charge.updated — no transition (audit only). Stripe fires this
    // for partial refund signaling, dispute updates, metadata changes,
    // etc. We resolve the pagamento for the audit-trail link but don't
    // touch domain state.
    case 'charge.updated': {
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

/** Return a new Pagamento with the payment_intent ref set on intencao. */
function withPaymentIntentRef(
  pagamento: import('../../../../src/index.js').Pagamento,
  pi: string,
): import('../../../../src/index.js').Pagamento {
  return {
    ...pagamento,
    intencao: { ...pagamento.intencao, paymentIntentExternalRef: pi },
  };
}

/** Return a new Pagamento with the charge ref set on intencao. */
function withChargeRef(
  pagamento: import('../../../../src/index.js').Pagamento,
  ch: string,
): import('../../../../src/index.js').Pagamento {
  return {
    ...pagamento,
    intencao: { ...pagamento.intencao, chargeExternalRef: ch },
  };
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
