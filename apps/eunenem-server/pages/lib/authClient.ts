// BetterAuth browser client (aperture-8655f).
//
// The app's email+password auth goes through the tRPC `auth.*` procedures
// (see lib/auth.ts) — that path is unchanged. This client owns the social
// redirect and passwordless magic-link flows, which BetterAuth drives directly
// against its `/api/auth/*` handler (mounted in server.tsx). `signIn.social`
// issues the provider redirect; `signIn.magicLink` requests the email.
//
// baseURL is left to BetterAuth's same-origin default: the client bundle is
// served from the same origin as the auth handler (eunenem-server serves both
// the SSR pages and /api/auth/*), so relative `/api/auth/*` calls resolve to
// the right host automatically — dev (localhost:3001) or whatever live domain
// serves the app (no hardcoded host; aperture-ejghb).
import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';

// Password login remains owned by the tenant-bound tRPC procedures. The magic
// link client adds only the passwordless send call; native Better Auth
// email/password routes stay retired.
export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
