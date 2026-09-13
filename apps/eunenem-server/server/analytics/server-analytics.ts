import { createHash } from 'node:crypto';

import Mixpanel from 'mixpanel';

/**
 * Server-side analytics sink (aperture-ppuay PR2, hardened in aperture-4yse9).
 *
 * The server mirror of the client's single-abstraction analytics: every
 * server-truth event (payment approved, account created, campaign created,
 * repasse, RSVP) routes through ONE `track()` call, with distinct_id = the
 * actor's opaque id so server + client events land on the same Mixpanel
 * profile. Gated real-vs-noop on MIXPANEL_TOKEN in buildServerDeps, exactly
 * like objectStorage / pagamentoProvider — no token → no-op, the same
 * mounts-dark pattern as the client sink (byte-identical behavior when
 * unconfigured). Analytics is non-critical: never a boot guard, never throws
 * into a request path.
 *
 * DELIVERY CONTRACT (aperture-4yse9, root-binding): the database transition
 * is the truth; analytics delivery is BEST-EFFORT. Fire-and-forget over HTTP
 * cannot survive a process crash between the DB commit and the send, and a
 * webhook retry can re-enter a call site after a partial failure. Two
 * mitigations, neither a guarantee:
 *   - callers pass `insertKey` (the business idempotency key, e.g. the
 *     idPagamento) → a deterministic `$insert_id`. Per Mixpanel's documented
 *     contract, duplicates are collapsed only when (event, time, distinct_id,
 *     $insert_id) all match at query time, or same-calendar-day at a later,
 *     non-guaranteed compaction (docs.mixpanel.com/reference/event-deduplication);
 *   - callers pass `occurredAt` (the fact's business timestamp) → `time`, so
 *     the same fact reported by two paths (webhook vs. reconciliation) carries
 *     the SAME timestamp instead of two send times — without that, the
 *     query-time dedup above never matches.
 * Every call site ALSO guards on the pre-transition status so a replay that
 * finalizes as a no-op does not re-track at all.
 */
export interface ServerAnalyticsTrackOptions {
  /**
   * Business idempotency key for this fact (idPagamento, ...). Same key ⇒
   * same `$insert_id`. Omit for events with no natural key (the SDK/API then
   * assigns a random one and the event never qualifies for dedup).
   */
  readonly insertKey?: string;
  /** When the fact happened (defaults to send time at the API). */
  readonly occurredAt?: Date;
}

export interface ServerAnalytics {
  /**
   * Fire a server event. `distinctId` is the actor's OPAQUE id — a conta id
   * for account holders (matches the client's `identify(idConta)`), or an
   * existing-actor id with a kind prefix for guests (`convidado:<id>`, see
   * `distinctIdConvidado`). `null` means "no actor could be resolved": the
   * event is DROPPED and reported via `onDropped`, never filed under a shared
   * placeholder profile (Mixpanel rejects the literal 'anon' outright) and
   * never attributed to a campaign as if it were a person.
   */
  track(
    event: string,
    distinctId: string | null,
    props?: Record<string, unknown>,
    options?: ServerAnalyticsTrackOptions,
  ): void;
}

/** Opaque distinct_id for a guest RSVP actor — stable per convidado, no PII. */
export function distinctIdConvidado(idConvidado: string): string {
  return `convidado:${idConvidado}`;
}

/**
 * Deterministic `$insert_id` from (event, business key). Mixpanel caps the
 * field at 36 bytes of `[A-Za-z0-9-]`; a raw `${event}:${uuid}` overflows, so
 * we hash and format the digest as a 36-char UUID-shaped string (Mixpanel's
 * own recommendation: "computing a hash of some set of properties that make
 * the event semantically unique ... first 36 characters"). Pure — unit-tested.
 */
export function insertIdFor(event: string, insertKey: string): string {
  const hex = createHash('sha256').update(`${event} ${insertKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type MixpanelInstance = ReturnType<typeof Mixpanel.init>;
type MixpanelTrackClient = Pick<MixpanelInstance, 'track'>;

export interface ServerAnalyticsMixpanelOptions {
  /** Test seam / composition override; defaults to `Mixpanel.init(token)`. */
  readonly client?: MixpanelTrackClient;
  /** Called when an event is dropped for lack of an actor (never throws through). */
  readonly onDropped?: (event: string, props: Record<string, unknown>) => void;
}

/** Real Mixpanel Node sink — bound when MIXPANEL_TOKEN is present. */
export class ServerAnalyticsMixpanel implements ServerAnalytics {
  private readonly mp: MixpanelTrackClient;
  private readonly onDropped: ServerAnalyticsMixpanelOptions['onDropped'];

  constructor(token: string, options: ServerAnalyticsMixpanelOptions = {}) {
    this.mp = options.client ?? Mixpanel.init(token);
    this.onDropped = options.onDropped;
  }

  track(
    event: string,
    distinctId: string | null,
    props: Record<string, unknown> = {},
    options: ServerAnalyticsTrackOptions = {},
  ): void {
    try {
      if (distinctId === null || distinctId.length === 0) {
        // Explicitly handled absence — see the interface doc.
        this.onDropped?.(event, props);
        return;
      }
      // Every server event is stamped `source: 'server'` so a server-truth
      // event (e.g. the webhook's pagamento_aprovado) is distinguishable in
      // Mixpanel from a same-named client sink event.
      const payload: Record<string, unknown> = {
        distinct_id: distinctId,
        source: 'server',
        ...props,
      };
      if (options.insertKey) payload.$insert_id = insertIdFor(event, options.insertKey);
      // The node lib converts a Date to epoch milliseconds (accepted by /track;
      // events older than 5 days are rejected by the API — reconciliation
      // catches expired PIX charges within minutes/hours, well inside that).
      if (options.occurredAt) payload.time = options.occurredAt;
      this.mp.track(event, payload);
    } catch {
      // non-critical sink — swallow.
    }
  }
}

/** No-op sink — MIXPANEL_TOKEN absent (mounts-dark). */
export class ServerAnalyticsNaoConfigurado implements ServerAnalytics {
  track(): void {
    // intentional no-op
  }
}
