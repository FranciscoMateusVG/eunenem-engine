/**
 * aperture-g7l09 — `/campanhas` data hook (multicampanha migration bridge POC).
 *
 * The contract lives in `server/trpc/campanhas-router.ts` (Rex, PR #320,
 * epic aperture-7hm2g) — types below are INFERRED from the router, so the
 * frontend can never drift from the backend shape.
 *
 * Contract gotchas (banked on the epic):
 *   - `slug` is the USER's painel slug (a Campanha has no slug of its own) —
 *     in the POC every 2.0 card navigates to the same /painel/<slug>.
 *   - `null` counts mean HIDE the mimo line, not "0 mimos".
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../server/trpc/router.js';
import { trpc } from './trpc.js';

type CampanhasListOutput = inferRouterOutputs<AppRouter>['campanhas']['list'];

/** One 2.0 (new platform) campaign card. */
export type CampanhaNovaDTO = CampanhasListOutput['novas'][number];

/** One 1.0 (legacy eunenem.com) campaign card, from legacy-1.0-users.json. */
export type CampanhaLegadoDTO = CampanhasListOutput['legado'][number];

/**
 * localStorage flag for the first-visit welcome modal ("Bem-vindo à nova
 * EuNeném!"). Declared as an exported constant so Izzy's E2E (aperture-8jcec)
 * can pre-seed / clear it deterministically. Global (not per-user) for the
 * POC — bump the `v1` suffix if the modal copy materially changes and we
 * want everyone to see it again.
 */
export const CAMPANHAS_WELCOME_STORAGE_KEY = 'eunenem-campanhas:bemvindo-v1';

/**
 * The 1.0 card's fallback target — the legacy dashboard, where Clerk resolves
 * the user by email. Kept as the bridge's own fallback (server-side) and used
 * directly only if the bridge is ever disabled.
 */
export const LEGACY_DASHBOARD_URL = 'https://eunenem.com/minha-area';

/**
 * Where the 1.0 card actually points (aperture-as0v3). Same-origin authed
 * endpoint that mints a Clerk sign-in ticket for the caller's VERIFIED email
 * and 302s into the 1.0 system LOGGED IN (falling back to LEGACY_DASHBOARD_URL
 * server-side for unverified / no-match / no-key / error). A plain top-level
 * anchor nav so the browser carries the session cookie. Izzy's E2E (aperture-
 * 8jcec) asserts the anchor + this href — imported here so spec + test move
 * together.
 */
export const LEGACY_BRIDGE_PATH = '/api/legacy-bridge';

export function useCampanhasList() {
  return trpc.campanhas.list.useQuery(undefined, { staleTime: 30_000 });
}
