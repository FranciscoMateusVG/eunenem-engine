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
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function sendEvent(eventName: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !window.dataLayer) return;
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
