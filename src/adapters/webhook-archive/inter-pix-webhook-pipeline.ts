import { z } from 'zod/v4';
import type { MoneyCents } from '../../domain/money.js';
import type { PixCobrancaProvider } from '../pagamentos/pix-cobranca-provider.js';
import type { WebhookEventArchive } from './webhook-event-archive.js';

export const INTER_PIX_CHARGE_EVENT_TYPE = 'pix.recebido';
export const INTER_PIX_REFUND_EVENT_TYPE = 'pix.devolucao';
export const INTER_PIX_SIGNATURE_SENTINEL = 'not-provided-by-inter';
export const INTER_PIX_MAX_ITEMS = 100;
export const INTER_PIX_MAX_REFUNDS_PER_ITEM = 20;
export const INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES = 128;

const RefundHintSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9]{1,35}$/),
  })
  .strip();

const PixHintSchema = z
  .object({
    endToEndId: z.string().regex(/^[A-Za-z0-9]{32}$/),
    txid: z.string().regex(/^[A-Za-z0-9]{26,35}$/),
    devolucoes: z.array(RefundHintSchema).max(INTER_PIX_MAX_REFUNDS_PER_ITEM).optional(),
  })
  .strip();

const InterPixEnvelopeSchema = z.object({
  pix: z.array(PixHintSchema).min(1).max(INTER_PIX_MAX_ITEMS),
});

export interface InterPixChargeConfirmed {
  readonly pagamentoId: string;
  readonly txid: string;
  readonly e2eId: string;
  readonly amountCents: number;
  readonly horario: Date;
}

export interface InterPixChargeIdentity {
  readonly txid: string;
  readonly e2eId: string;
}

export interface InterPixChargeBinding {
  readonly pagamentoId: string;
  readonly txid: string;
}

export interface InterPixRefundConfirmed {
  readonly e2eId: string;
  readonly idDevolucao: string;
}

export interface InterPixRefundBinding extends InterPixRefundConfirmed {
  readonly amountCents: MoneyCents;
}

export interface InterPixDispatchResult {
  readonly pagamentoId: string | null;
}

export interface InterPixPipelineArgs {
  readonly rawBody: string;
  readonly pixCobrancaProvider: PixCobrancaProvider;
  readonly onChargeConfirmed: (
    confirmed: InterPixChargeConfirmed,
  ) => Promise<InterPixDispatchResult>;
  /**
   * Binds the untrusted webhook txid to an eligible local Inter payment.
   * This check MUST finish before any provider API request is attempted.
   */
  readonly resolveChargeBinding: (
    identity: InterPixChargeIdentity,
  ) => Promise<InterPixChargeBinding | null>;
  /** Resolves the persisted amount; webhook payload values are never trusted. */
  readonly resolveRefundBinding: (
    identity: InterPixRefundConfirmed,
  ) => Promise<InterPixRefundBinding | null>;
  /**
   * B6 plugs refund bookkeeping into this verified-result seam. B3 never
   * calls a refund initiation method from a post-money-movement webhook.
   */
  readonly onRefundConfirmed: (
    confirmed: InterPixRefundConfirmed,
  ) => Promise<InterPixDispatchResult>;
}

export type InterPixItemOutcome =
  | 'dispatched_success'
  | 'duplicate_processed'
  | 'duplicate_in_flight'
  | 'charge_not_confirmed'
  | 'charge_binding_failed'
  | 'charge_identity_mismatch'
  | 'charge_requery_failed'
  | 'charge_bookkeeping_failed'
  | 'refund_not_confirmed'
  | 'refund_binding_failed'
  | 'refund_requery_failed'
  | 'refund_bookkeeping_failed';

export interface InterPixItemResult {
  readonly providerEventId: string;
  readonly archiveId: string;
  readonly outcome: InterPixItemOutcome;
}

export interface InterPixPipelineResult {
  readonly status: 200 | 400;
  readonly body: 'ok' | 'invalid event shape';
  readonly outcome: 'accepted' | 'malformed_body';
  readonly items: readonly InterPixItemResult[];
}

interface ParsedChargeEvent {
  readonly providerEventId: string;
  readonly eventType: typeof INTER_PIX_CHARGE_EVENT_TYPE;
  readonly archivePayload: {
    readonly txid: string;
    readonly endToEndId: string;
  };
  readonly hint: { readonly kind: 'charge'; readonly txid: string; readonly e2eId: string };
}

interface ParsedRefundEvent {
  readonly providerEventId: string;
  readonly eventType: typeof INTER_PIX_REFUND_EVENT_TYPE;
  readonly archivePayload: {
    readonly endToEndId: string;
    readonly idDevolucao: string;
  };
  readonly hint: {
    readonly kind: 'refund';
    readonly e2eId: string;
    readonly idDevolucao: string;
  };
}

type ParsedEvent = ParsedChargeEvent | ParsedRefundEvent;

/**
 * Archive and verify one Banco Inter Pix webhook envelope.
 *
 * Inter does not sign these payloads. The payload is therefore only a
 * bounded routing hint: every locally-bound event is re-queried through
 * PixCobrancaProvider before a callback can mutate state. Unknown charge
 * txids fail before provider I/O. Accepted envelopes return 200 even when
 * an item cannot be confirmed; the durable failed row plus B4 reconciliation
 * own recovery. Archive-write failures still throw so the HTTP handler returns
 * 500 rather than acknowledging an event we did not durably record.
 */
export async function archiveAndDispatchInterPixWebhook(
  archive: WebhookEventArchive,
  args: InterPixPipelineArgs,
): Promise<InterPixPipelineResult> {
  const parsedEvents = parseEnvelope(args.rawBody);
  if (!parsedEvents) {
    return {
      status: 400,
      body: 'invalid event shape',
      outcome: 'malformed_body',
      items: [],
    };
  }

  const items: InterPixItemResult[] = [];
  for (const event of parsedEvents) {
    items.push(await processEvent(archive, args, event));
  }

  return { status: 200, body: 'ok', outcome: 'accepted', items };
}

function parseEnvelope(rawBody: string): readonly ParsedEvent[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const parsed = InterPixEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const events: ParsedEvent[] = [];

  parsed.data.pix.forEach((pix) => {
    const refunds = pix.devolucoes ?? [];
    if (refunds.length > 0) {
      for (const refund of refunds) {
        events.push({
          providerEventId: `${pix.endToEndId}:devolucao:${refund.id}`,
          eventType: INTER_PIX_REFUND_EVENT_TYPE,
          archivePayload: {
            endToEndId: pix.endToEndId,
            idDevolucao: refund.id,
          },
          hint: {
            kind: 'refund',
            e2eId: pix.endToEndId,
            idDevolucao: refund.id,
          },
        });
      }
      return;
    }

    events.push({
      providerEventId: pix.endToEndId,
      eventType: INTER_PIX_CHARGE_EVENT_TYPE,
      archivePayload: { txid: pix.txid, endToEndId: pix.endToEndId },
      hint: { kind: 'charge', txid: pix.txid, e2eId: pix.endToEndId },
    });
  });

  return events;
}

async function processEvent(
  archive: WebhookEventArchive,
  args: InterPixPipelineArgs,
  event: ParsedEvent,
): Promise<InterPixItemResult> {
  const saved = await archive.saveReceived({
    provider: 'inter',
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    // Inter does not sign callbacks. Persist only the strict routing identity,
    // never the attacker-controlled provider object or payer metadata.
    rawPayload: event.archivePayload,
    signatureHeader: INTER_PIX_SIGNATURE_SENTINEL,
    signatureValid: false,
  });

  if (saved.isDuplicate) {
    const existing = await archive.findById(saved.id);
    if (existing?.processedAt) {
      return result(event, saved.id, 'duplicate_processed');
    }
    if (!existing?.processingError) {
      return result(event, saved.id, 'duplicate_in_flight');
    }
    // A prior authoritative read/bookkeeping attempt failed. Claim the retry
    // with one durable compare-and-set before re-querying or dispatching.
    // Only the successful claimant may proceed; concurrent redeliveries see
    // the cleared failure as in-flight and cannot duplicate side effects.
    const claimed = await archive.tryClaimFailedForRetry(saved.id);
    if (!claimed) {
      const afterClaim = await archive.findById(saved.id);
      return result(
        event,
        saved.id,
        afterClaim?.processedAt ? 'duplicate_processed' : 'duplicate_in_flight',
      );
    }
  }

  if (event.eventType === INTER_PIX_CHARGE_EVENT_TYPE) {
    return processCharge(archive, args, event, saved.id);
  }
  return processRefund(archive, args, event, saved.id);
}

async function processCharge(
  archive: WebhookEventArchive,
  args: InterPixPipelineArgs,
  event: ParsedChargeEvent,
  archiveId: string,
): Promise<InterPixItemResult> {
  let binding: InterPixChargeBinding | null;
  try {
    binding = await args.resolveChargeBinding({
      txid: event.hint.txid,
      e2eId: event.hint.e2eId,
    });
  } catch {
    return fail(archive, event, archiveId, 'charge_binding_failed');
  }
  if (binding === null || binding.txid !== event.hint.txid) {
    return fail(archive, event, archiveId, 'charge_binding_failed');
  }

  let authoritative: Awaited<ReturnType<PixCobrancaProvider['consultarCobranca']>>;
  try {
    authoritative = await args.pixCobrancaProvider.consultarCobranca(event.hint.txid);
  } catch {
    return fail(archive, event, archiveId, 'charge_requery_failed');
  }

  if (authoritative.status !== 'concluida') {
    return fail(archive, event, archiveId, 'charge_not_confirmed');
  }
  if (authoritative.e2eId !== event.hint.e2eId) {
    return fail(archive, event, archiveId, 'charge_identity_mismatch');
  }

  try {
    const dispatched = await args.onChargeConfirmed({
      pagamentoId: binding.pagamentoId,
      txid: event.hint.txid,
      e2eId: authoritative.e2eId,
      amountCents: authoritative.valorPagoCents,
      horario: authoritative.horario,
    });
    await archive.markProcessed(archiveId, dispatched.pagamentoId);
    return result(event, archiveId, 'dispatched_success');
  } catch {
    return fail(archive, event, archiveId, 'charge_bookkeeping_failed');
  }
}

async function processRefund(
  archive: WebhookEventArchive,
  args: InterPixPipelineArgs,
  event: ParsedRefundEvent,
  archiveId: string,
): Promise<InterPixItemResult> {
  let binding: InterPixRefundBinding | null;
  try {
    binding = await args.resolveRefundBinding({
      e2eId: event.hint.e2eId,
      idDevolucao: event.hint.idDevolucao,
    });
  } catch {
    return fail(archive, event, archiveId, 'refund_binding_failed');
  }
  if (
    binding === null ||
    binding.e2eId !== event.hint.e2eId ||
    binding.idDevolucao !== event.hint.idDevolucao
  ) {
    return fail(archive, event, archiveId, 'refund_binding_failed');
  }

  let authoritative: Awaited<ReturnType<PixCobrancaProvider['consultarDevolucao']>>;
  try {
    authoritative = await args.pixCobrancaProvider.consultarDevolucao(binding);
  } catch {
    return fail(archive, event, archiveId, 'refund_requery_failed');
  }

  if (authoritative.status !== 'devolvida') {
    return fail(archive, event, archiveId, 'refund_not_confirmed');
  }

  try {
    const dispatched = await args.onRefundConfirmed({
      e2eId: event.hint.e2eId,
      idDevolucao: event.hint.idDevolucao,
    });
    await archive.markProcessed(archiveId, dispatched.pagamentoId);
    return result(event, archiveId, 'dispatched_success');
  } catch {
    return fail(archive, event, archiveId, 'refund_bookkeeping_failed');
  }
}

async function fail(
  archive: WebhookEventArchive,
  event: ParsedEvent,
  archiveId: string,
  outcome: Exclude<
    InterPixItemOutcome,
    'dispatched_success' | 'duplicate_processed' | 'duplicate_in_flight'
  >,
): Promise<InterPixItemResult> {
  // Only categorical constants reach processing_error. Provider/body/error
  // messages may contain payer PII and must never be persisted or logged.
  await archive.markFailed(archiveId, outcome);
  return result(event, archiveId, outcome);
}

function result(
  event: ParsedEvent,
  archiveId: string,
  outcome: InterPixItemOutcome,
): InterPixItemResult {
  return { providerEventId: event.providerEventId, archiveId, outcome };
}
