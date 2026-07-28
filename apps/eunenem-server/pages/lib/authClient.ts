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
// the right host automatically — dev (localhost:3001) or whatever live domain
// serves the app (no hardcoded host; aperture-ejghb).
import { createAuthClient } from 'better-auth/react';

// Password login is owned by the tenant-bound tRPC procedures. Magic-link is
// deliberately absent on both client and server while Better Auth's verifier
// remains email-global. This client exposes only the social redirect surface.
export const authClient = createAuthClient();
