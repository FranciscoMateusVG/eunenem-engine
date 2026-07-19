// aperture-ga4gtm: single entry point for custom event tracking. GTM/GA
// scripts are injected server-side by server.tsx's envelope() (gtag.js +
// GTM container). Both read window.dataLayer, but they expect DIFFERENT
// push shapes:
//   - gtag.js only recognizes the Arguments-array shape produced by calling
//     window.gtag('event', name, params) — that's what forwards the event to
//     GA4. A plain {event, ...} object push is invisible to gtag.js; it's
//     only picked up by a GTM container if a trigger is configured for it.
//   - GTM's container listens for {event: name, ...} objects.
// Calling window.gtag() covers the GA4 path directly (no GTM tag/trigger
// setup required); pushing the object form additionally keeps it visible to
// the GTM container for anyone who *does* want to wire a trigger there.
//
// aperture-ppuay: Mixpanel is a SECOND sink here. Every event that flows through
// sendEvent()/sendPageView() (the whole EVENT_MAP taxonomy) also fires to
// Mixpanel with ZERO per-call-site changes. The token is read at runtime from
// window.__EUNENEM_ENV__.mixpanelToken (injected per-request by server.tsx;
// the Window type is declared in ./campanhas.ts). No token → the sink stays
// DARK (every track/identify below no-ops), GA/gtag unaffected — the
// mounts-dark house pattern, byte-identical behavior when unconfigured.
import mixpanel from 'mixpanel-browser';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

// Lazy, idempotent Mixpanel init. Decided once on the client (never during SSR).
let mixpanelState: 'pending' | 'on' | 'off' = 'pending';

function mixpanelOn(): boolean {
  if (mixpanelState !== 'pending') return mixpanelState === 'on';
  if (typeof window === 'undefined') return false; // decide on the client only
  const token = window.__EUNENEM_ENV__?.mixpanelToken;
  if (!token) {
    mixpanelState = 'off';
    return false;
  }
  // Config per the operator's fresh project: full autocapture (clicks/pageviews)
  // + full session replay, localStorage persistence. Single init kills the
  // old-site's dual-init race that non-deterministically set session-replay %.
  mixpanel.init(token, {
    autocapture: true,
    record_sessions_percent: 100,
    persistence: 'localStorage',
  });
  mixpanelState = 'on';
  return true;
}

export function sendEvent(eventName: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  // Mixpanel sink — fired BEFORE the dataLayer guard so it tracks even when
  // GTM/gtag isn't present on the page. No-ops when the token is absent.
  if (mixpanelOn()) {
    mixpanel.track(eventName, data);
  }
  if (!window.dataLayer) return;
  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, data);
  } else {
    window.dataLayer.push({ event: eventName, ...data });
  }
}

// Custom pageview — the app has no client-side router (every navigation is a
// full page load), but GA4's automatic page_view only carries the URL. This
// carries a human-readable page_name (e.g. "Convidados") so painel sections
// are distinguishable in reports without parsing the slug out of the path.
export function sendPageView(pageName: string, data?: Record<string, unknown>): void {
  sendEvent('page_view_custom', { page_name: pageName, ...data });
}

// Identify the authenticated account on Mixpanel (distinct_id = conta id). Call
// once auth resolves (AuthModalProvider). No-op when Mixpanel is dark.
export function identifyUser(distinctId: string): void {
  if (mixpanelOn()) {
    mixpanel.identify(distinctId);
  }
}

// people.set_once — first-touch props (e.g. utm_source) that must NOT be
// overwritten on later visits. No-op when Mixpanel is dark.
export function setOnceUserProps(props: Record<string, unknown>): void {
  if (mixpanelOn()) {
    mixpanel.people.set_once(props);
  }
}

// Identify the resolved account AND attach its first-touch utm_source (captured
// to localStorage by the landing page). identify() runs BEFORE set_once() so the
// props land on the identified profile rather than the anonymous one. This is the
// one call auth-resolution sites make — login (AuthModalProvider) and signup
// completion (OnboardingWizard). No-op when Mixpanel is dark. localStorage reads
// are guarded: Safari private mode throws on access.
export function identifyWithUtm(distinctId: string): void {
  identifyUser(distinctId);
  if (typeof window === 'undefined') return;
  try {
    const utmSource = window.localStorage.getItem('eunenem:utm_source');
    if (utmSource) setOnceUserProps({ utm_source: utmSource });
  } catch {
    // localStorage unavailable (private mode / disabled) — skip first-touch attr.
  }
}
