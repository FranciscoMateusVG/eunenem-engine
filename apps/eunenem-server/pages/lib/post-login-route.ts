/**
 * aperture-w3rrd — post-login routing hardening.
 *
 * ONE place that owns "where does a resolved auth.me go, and how do we resolve
 * it robustly through the login cookie race". Both redirect consumers
 * (useOauthReturnRedirect + AuthModalProvider) and the /campanhas direct-nav
 * gate route through here so the rule can never drift between entry points.
 *
 * Routing rule (binds to Rex's lrl1h me.isLegacy/me.needsOnboarding contract):
 *   isLegacy            → /campanhas   (migrating from 1.0; the hub with their
 *                                       1.0 card outranks the onboarding wizard)
 *   needsOnboarding     → /painel/<slug>  (PainelPage mounts the blocking wizard)
 *   otherwise (onboarded) → /campanhas
 */

import { isLegacy, needsOnboarding } from "./onboarding-gate.js";

/** A minimal shape — the real me is the inferred auth.me output. */
type MeLike = { slug?: string | null } | null | undefined;

/**
 * The destination for a *resolved, authenticated* me. Never returns a wizard
 * path without a slug (falls back to /campanhas — CampanhasPage re-checks auth).
 */
export function postLoginTarget(me: MeLike): string {
  if (isLegacy(me)) return "/campanhas";
  if (needsOnboarding(me) && me?.slug) return `/painel/${me.slug}`;
  return "/campanhas";
}

/**
 * Resolve auth.me through the post-login cookie race. The OAuth callback / email
 * flow has just set the session cookie; a single fetch can still read a stale
 * anonymous value, which used to leave a logged-in user stranded on the landing
 * page. Retry a bounded number of times until me carries a slug (a valid
 * session), then return it. A genuinely-unauthenticated caller resolves to null
 * every time and gets null back — so the caller can correctly keep them on the
 * landing page. Total worst-case wait ≈ 1.35s (4 attempts), then give up.
 */
export async function resolveMeWithRetry<T extends { slug?: string | null }>(
  fetchMe: () => Promise<T | null>,
): Promise<T | null> {
  const DELAYS_MS = [0, 150, 400, 800];
  for (const delay of DELAYS_MS) {
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const me = await fetchMe();
    if (me?.slug) return me;
  }
  return null;
}
