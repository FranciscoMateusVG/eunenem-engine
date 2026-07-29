// BetterAuth browser client (aperture-8655f).
//
// This client owns every account-entry flow: social redirect and passwordless
// magic link. BetterAuth drives both directly against its `/api/auth/*` handler
// (mounted in server.tsx). `signIn.social` issues the provider redirect;
// `signIn.magicLink` requests the email. Password authentication is disabled.
//
// baseURL is left to BetterAuth's same-origin default: the client bundle is
// served from the same origin as the auth handler (eunenem-server serves both
// the SSR pages and /api/auth/*), so relative `/api/auth/*` calls resolve to
// the right host automatically — dev (localhost:3001) or whatever live domain
// serves the app (no hardcoded host; aperture-ejghb).
import { createAuthClient } from 'better-auth/react';
import { magicLinkClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
