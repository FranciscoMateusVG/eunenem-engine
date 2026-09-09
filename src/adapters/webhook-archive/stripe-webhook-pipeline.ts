import type Stripe from 'stripe';
import type { WebhookEventArchive } from './webhook-event-archive.js';

/**
 * Stripe-specific archive + verify + dispatch pipeline (aperture-1n6u8).
 *
 * The Hono webhook handler in
 * `apps/eunenem-server/server/webhooks/stripe-webhook.ts` is dumb glue:
 * it pulls the raw body + signature off the HTTP request, hands them
 * here, and translates the returned `{status, body}` to a `Response`.
 * All the archive + verify + dispatch coordination lives in this pure
 * function so it can be tested without spinning a Hono app.
 *
 * Lifecycle per the bead spec:
 *
 *   1. Parse JSON to extract `event.id` + `event.type`. Malformed JSON
 *      OR missing fields → 400, NO archive row written (we have no
 *      `providerEventId` to key by).
 *
 *   2. Verify the signature against the raw body. The result becomes
 *      `signatureValid` in the archive row.
 *
 *   3. Archive: INSERT with `signatureValid` set. ON CONFLICT
 *      (provider, providerEventId) DO NOTHING. Receipt duplication does not
 *      imply the prior dispatch committed.
 *
 *   4. If signature invalid: 400, NO domain dispatch. Row is archived
 *      with `signature_valid=false` — forensic evidence of the attempt.
 *
 *   5. If signature valid: acquire a fenced lease, dispatch domain side
 *      effects, and acknowledge 200 only after the processed fact commits.
 *      Failed or active work remains retryable non-2xx.
 *
 * Write-before-verify discipline is captured by the order above: the
 * archive write happens with the freshly-computed `signatureValid`
 * before any dispatch. The DB write costs one round-trip per attack
 * attempt — acceptable for the forensic value of capturing rejected
 * requests.
 */

/** What the handler should send back as the HTTP response. */
export interface StripePipelineResult {
  readonly status: number;
  readonly body: string;
  /** The archive row id, when one was created/found. Useful for logging. */
  readonly archiveId?: string;
  /**
   * Categorical outcome — used for structured logging + tracing
   * attributes. Helpful for forensic dashboards ("how many retries
   * vs first-deliveries?").
   */
  readonly outcome:
    | 'malformed_body'
    | 'duplicate_retry'
    | 'retryable_in_flight'
    | 'signature_failed'
    | 'dispatched_success'
    | 'dispatched_failed';
}

/** Outcome of the dispatch callback. */
export interface StripeDispatchResult {
  /**
   * The pagamento_id resolved from the event, if any. Many event
   * types don't resolve to a pagamento (`payment_intent.payment_failed`
   * when metadata is missing, or unknown event types) — those return
   * `null`. The archive row's `pagamento_id` carries this for forensic
   * "all webhook events for pagamento X" queries.
   */
  readonly pagamentoId: string | null;
}

export interface StripePipelineArgs {
  readonly rawBody: string;
  readonly signatureHeader: string;
  /**
   * Verifies the signature against the raw body. Should throw on
   * verification failure (matching `Stripe.Webhooks.constructEvent`
   * behavior). The returned event is passed to `dispatch` if verify
   * succeeds.
   */
  readonly verifyEvent: (rawBody: string, signatureHeader: string) => Stripe.Event;
  /**
   * Domain side-effects for a verified event. Returns the resolved
   * `pagamentoId` (null if the event didn't resolve to one). Throws on
   * domain failure — the pipeline catches, calls `markFailed`, and
   * returns 500.
   */
  readonly dispatch: (event: Stripe.Event) => Promise<StripeDispatchResult>;
}

/**
 * Run the full archive + verify + dispatch pipeline for one Stripe
 * webhook delivery. See file header for the lifecycle contract.
 */
export async function archiveAndDispatchStripeEvent(
  archive: WebhookEventArchive,
  args: StripePipelineArgs,
): Promise<StripePipelineResult> {
  // ─── 1. Parse JSON to extract event.id + event.type ─────────────────
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(args.rawBody);
  } catch {
    return { status: 400, body: 'invalid json', outcome: 'malformed_body' };
  }
  if (
    typeof parsedPayload !== 'object' ||
    parsedPayload === null ||
    typeof (parsedPayload as { id?: unknown }).id !== 'string' ||
    typeof (parsedPayload as { type?: unknown }).type !== 'string'
  ) {
    return { status: 400, body: 'invalid event shape', outcome: 'malformed_body' };
  }
  const obj = parsedPayload as { id: string; type: string };
  const preview = { id: obj.id, type: obj.type };

  // ─── 2. Verify signature (result determines signatureValid) ─────────
  let verifiedEvent: Stripe.Event | null = null;
  let signatureValid = false;
  try {
    verifiedEvent = args.verifyEvent(args.rawBody, args.signatureHeader);
    signatureValid = true;
  } catch {
    signatureValid = false;
  }

  // ─── 3. Archive (write-before-verify discipline; signatureValid
  //        already set at INSERT time). ON CONFLICT → isDuplicate=true. ─
  const archiveResult = await archive.saveReceived({
    provider: 'stripe',
    providerEventId: preview.id,
    eventType: preview.type,
    rawPayload: parsedPayload,
    signatureHeader: args.signatureHeader,
    signatureValid,
  });

  // ─── 4. Bail on invalid signature (row archived with signature_valid=false) ─
  if (!signatureValid || verifiedEvent === null) {
    return {
      status: 400,
      body: 'signature mismatch',
      archiveId: archiveResult.id,
      outcome: 'signature_failed',
    };
  }

  // A known relevant event is acknowledged only after its durable processed
  // fact commits. Failed, stale, or fresh rows compete for one fenced lease;
  // an active claimant remains retryable rather than being falsely 2xx'd.
  const now = new Date();
  const claim = await archive.claimForProcessing(
    archiveResult.id,
    now,
    new Date(now.getTime() + 30_000),
  );
  if (claim.status !== 'claimed') {
    if (claim.status === 'processed') {
      return {
        status: 200,
        body: 'ok (duplicate)',
        archiveId: archiveResult.id,
        outcome: 'duplicate_retry',
      };
    }
    return {
      status: 503,
      body: 'processing incomplete',
      archiveId: archiveResult.id,
      outcome: 'retryable_in_flight',
    };
  }

  // ─── 5. Dispatch + mark processed/failed ────────────────────────────
  try {
    const dispatchResult = await args.dispatch(verifiedEvent);
    const committed = await archive.markProcessedFenced(
      archiveResult.id,
      claim.fenceToken,
      dispatchResult.pagamentoId,
    );
    if (!committed) {
      return {
        status: 503,
        body: 'processing incomplete',
        archiveId: archiveResult.id,
        outcome: 'retryable_in_flight',
      };
    }
    return {
      status: 200,
      body: 'ok',
      archiveId: archiveResult.id,
      outcome: 'dispatched_success',
    };
  } catch (dispatchError) {
    const errMsg = (dispatchError as Error).message ?? String(dispatchError);
    await archive.markFailedFenced(archiveResult.id, claim.fenceToken, errMsg);
    return {
      status: 500,
      body: 'downstream error',
      archiveId: archiveResult.id,
      outcome: 'dispatched_failed',
    };
  }
}
