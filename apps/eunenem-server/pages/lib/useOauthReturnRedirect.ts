import { useEffect } from "react";

import { postLoginTarget, resolveMeWithRetry } from "./post-login-route.js";
import { trpc } from "./trpc.js";

/**
 * aperture-ydj4a — forward OAuth (Google) users to their painel after the
 * social-login callback returns to the landing.
 *
 * WHY THIS EXISTS: the email flow redirects via AuthModalProvider.onAuthenticated
 * (reads auth.me → window.location.assign('/painel/<slug>')). The OAuth flow does
 * a FULL-PAGE redirect to Google and back, so that handler never runs on the
 * return path — the user lands signed-in on the landing but is never forwarded.
 * AuthModalShell sets the BetterAuth `callbackURL` to '/?oauth=1'; this hook
 * detects that marker on landing mount and reproduces the email-flow redirect.
 *
 * GUARDRAILS:
 *  - Only fires when the `?oauth=1` marker is present, so a logged-in user who
 *    navigates to the landing on purpose is NOT force-redirected.
 *  - The redirect target's slug comes from the SERVER (auth.me), never from a
 *    URL param — so this is not an open-redirect surface. The marker itself is
 *    a fixed, same-origin literal, also not user-controlled.
 *  - The marker is stripped from the URL first (replaceState) so a refresh or
 *    bookmark can't re-trigger the redirect or leave a sticky query param.
 *  - Graceful degradation: if auth.me resolves null / no slug (race, expired
 *    cookie), we clear the marker and stay — the navbar renders the correct
 *    auth state on its own. Mirrors onAuthenticated's failure handling.
 */
export function useOauthReturnRedirect(): void {
  const utils = trpc.useUtils();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("oauth") !== "1") return;

    // Strip the marker immediately so a refresh can't re-run this redirect.
    params.delete("oauth");
    const query = params.toString();
    const cleaned =
      window.location.pathname +
      (query ? `?${query}` : "") +
      window.location.hash;
    window.history.replaceState(null, "", cleaned);

    let cancelled = false;
    void (async () => {
      try {
        // aperture-w3rrd (gap 2) — resolve auth.me through the just-set OAuth
        // cookie race with a bounded retry, so a real session is never mistaken
        // for anonymous and stranded on the landing. staleTime: 0 forces a fresh
        // resolve on each attempt (the session cookie was just set by the
        // callback; a hydrated anonymous value must not be trusted).
        const me = await resolveMeWithRetry(() =>
          utils.auth.me.fetch(undefined, { staleTime: 0 }),
        );
        if (cancelled) return;
        // Genuinely-unauthenticated (or a persistent race) → me stays null: keep
        // the user on the landing; the navbar renders the correct auth state.
        if (!me?.slug) return;
        // Route by the single shared post-login rule (legacy → /campanhas;
        // needs-onboarding → wizard; onboarded → /campanhas) so no entry point
        // can drift — see pages/lib/post-login-route.ts.
        const target = postLoginTarget(me);
        if (window.location.pathname === target) return;
        window.location.assign(target);
      } catch {
        // Graceful degradation — stay on the landing; navbar shows auth state.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [utils]);
}
