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
 * EVENT DISPATCH TABLE:
 *
 *   checkout.session.completed       → finalizarPagamentoAprovado
 *   checkout.session.expired         → finalizarPagamentoRejeitado
 *   payment_intent.payment_failed    → finalizarPagamentoRejeitado
 *   (anything else)                  → log info + 200 no-op
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
  finalizarPagamentoAprovado,
  finalizarPagamentoRejeitado,
  IdPagamentoSchema,
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

async function dispatchVerifiedStripeEvent(
  deps: ServerDeps,
  span: Span,
  event: Stripe.Event,
): Promise<{ pagamentoId: string | null }> {
  const { logger } = deps.observability;

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const pagamento = await deps.pagamentoRepository.findByExternalRef(session.id);
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
      // aperture-m95f3: extract contribuinte data from the Stripe
      // session itself — Stripe collects nome + mensagem via
      // custom_fields and email via customer_creation. Pass to
      // finalize so the contribuicao gets claimed at the
      // payment-settled moment (NOT at session-create — see
      // iniciar-pagamento-contribuicao.ts header for rationale).
      const contribuinte = extractContribuinteFromSession(session);
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
      // The session id is NOT in the PI payload. Stripe does not
      // backlink PI → Session in webhook events. We read
      // metadata.idPagamento (stamped at session create time in
      // provider.stripe.ts; it propagates to the PI's metadata).
      const pi = event.data.object as Stripe.PaymentIntent;
      const rawIdPagamento = pi.metadata?.idPagamento;
      if (!rawIdPagamento) {
        logger.info('webhook.stripe.missing_metadata', {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId: pi.id,
        });
        return { pagamentoId: null };
      }
      // Defensive: metadata is arbitrary string-keyed bag. Validate
      // the shape before handing it to findById so a malformed
      // upstream event becomes a logged no-op, not a crash.
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
      const pagamento = await deps.pagamentoRepository.findById(idPagamento);
      if (!pagamento) {
        logger.info('webhook.stripe.unknown_pagamento', {
          eventId: event.id,
          eventType: event.type,
          paymentIntentId: pi.id,
          idPagamento,
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

    default: {
      logger.info('webhook.stripe.unknown_event', {
        eventId: event.id,
        eventType: event.type,
      });
      return { pagamentoId: null };
    }
  }
}
