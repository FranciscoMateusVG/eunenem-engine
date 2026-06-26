// BetterAuth browser client (aperture-8655f).
//
// The app's email+password auth goes through the tRPC `auth.*` procedures
// (see lib/auth.ts) — that path is unchanged. This client exists ONLY for
// the social-login redirect flow, which BetterAuth drives directly against
// its `/api/auth/*` handler (mounted in server.tsx). `signIn.social` issues
// the provider redirect and, after the OAuth callback at
// `/api/auth/callback/google`, returns the browser to `callbackURL`.
//
// baseURL is left to BetterAuth's same-origin default: the client bundle is
// served from the same origin as the auth handler (eunenem-server serves both
// the SSR pages and /api/auth/*), so relative `/api/auth/*` calls resolve to
// the right host in dev (localhost:3001) and prod (eunenem.xeroxtoxerox.com).
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
