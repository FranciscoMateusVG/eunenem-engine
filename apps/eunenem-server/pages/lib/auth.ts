// Passwordless authentication client helpers (aperture-cusen).
//
// Account entry is owned by BetterAuth's OAuth and magic-link client in
// authClient.ts. The tRPC auth router deliberately exposes only session
// inspection and logout; no password signup/login mutation exists.

import { useCallback } from "react";

import { resetAnalyticsIdentity } from "./analytics.js";
import { trpc } from "./trpc.js";

/** Currently-authenticated user as returned by `auth.me`. */
export interface AuthUser {
  idUsuario: string;
  idConta: string;
  idPlataforma: string;
  email: string;
  nomeExibicao: string;
  /** Public URL slug used by post-auth navigation. */
  slug: string;
}

/** RFC5322-lite — matches `local@domain.tld` shapes the user actually types. */
export function isValidEmail(email: string): boolean {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function useSignOut() {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.signOut.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
      // aperture-d2r21 — drop the Mixpanel identity with the session so the
      // next login on this browser can't inherit (or extend) this account's
      // tracked identity. Mirrors identifyWithUtm at the login-resolution
      // sites (useOauthReturnRedirect, OnboardingWizard).
      resetAnalyticsIdentity();
    },
  });

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await mutation.mutateAsync();
    } catch {
      // Logout is idempotent. Preserve the existing graceful degradation: a
      // transient network error must not strand the UI in an error modal.
    }
  }, [mutation]);

  return { signOut, isPending: mutation.isPending };
}

/** Current-user probe. Returns null when no valid OAuth/magic-link session exists. */
export function useMe() {
  return trpc.auth.me.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}
