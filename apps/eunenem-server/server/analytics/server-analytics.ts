import Mixpanel from 'mixpanel';

/**
 * Server-side analytics sink (aperture-ppuay PR2).
 *
 * The server mirror of the client's single-abstraction analytics: every
 * server-truth event (payment approved, account created, login, campaign
 * created, repasse, RSVP) routes through ONE `track()` call, with
 * distinct_id = the actor's idConta so server + client events land on the
 * same Mixpanel profile. Gated real-vs-noop on MIXPANEL_TOKEN in
 * buildServerDeps, exactly like objectStorage / pagamentoProvider — no token
 * → no-op, the same mounts-dark pattern as the client sink (byte-identical
 * behavior when unconfigured). Analytics is non-critical: never a boot guard,
 * never throws into a request path.
 */
export interface ServerAnalytics {
  /**
   * Fire a server event. `distinctId` is the actor's conta id; pass null for
   * an anonymous/guest actor (e.g. a public RSVP) — the sink stamps a stable
   * anon marker so the event still counts without cross-linking to a profile.
   */
  track(event: string, distinctId: string | null, props?: Record<string, unknown>): void;
}

type MixpanelInstance = ReturnType<typeof Mixpanel.init>;

/** Real Mixpanel Node sink — bound when MIXPANEL_TOKEN is present. */
export class ServerAnalyticsMixpanel implements ServerAnalytics {
  private readonly mp: MixpanelInstance;

  constructor(token: string) {
    this.mp = Mixpanel.init(token);
  }

  track(event: string, distinctId: string | null, props: Record<string, unknown> = {}): void {
    // Fire-and-forget over HTTP; analytics must NEVER block or throw into a
    // request path. A guest (null id) lands on the 'anon' bucket — the event
    // still counts, just not tied to a conta profile. Every server event is
    // stamped `source: 'server'` so a server-truth event (e.g. the webhook's
    // pagamento_aprovado, or the authoritative presenca_confirmada) is
    // distinguishable in Mixpanel from a same-named client sink event.
    try {
      this.mp.track(event, {
        distinct_id: distinctId ?? 'anon',
        source: 'server',
        ...props,
      });
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
