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
import { useCampanhaRota } from './campanha-rota.js';
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
 * Where the 1.0 card actually points (aperture-pjd74, supersedes the silent
 * bridge from aperture-as0v3 — operator pivot 2026-07-08). The old site's
 * dedicated /migracao explainer page: sets the expectation that 1.0 and 2.0
 * are separate systems ("você precisa fazer login de novo"), then a Clerk
 * modal login → /minha-area (email-resolved 1.0 panel). The bridge endpoint
 * stays registered but inert (cleanup tracked separately). Izzy's E2E
 * (aperture-8jcec) asserts the anchor + this href — imported there so spec +
 * test move together.
 */
declare global {
  interface Window {
    /** Runtime config injected by server.tsx's envelope() (aperture-pjd74). */
    __EUNENEM_ENV__?: { legacyMigracaoUrl?: string };
  }
}

/**
 * Resolution order (aperture-pjd74 env-driven target — the /migracao page
 * lives on the OLD site, whose staging/prod hosts differ, so the new-system
 * staging must be able to point the card at staging.eunenem.com without a
 * rebuild):
 *   1. Browser: window.__EUNENEM_ENV__ — injected per-request by server.tsx
 *      from the container's LEGACY_MIGRACAO_URL env (runtime, Dokploy-set).
 *   2. Server/SSR + node test contexts: process.env.LEGACY_MIGRACAO_URL.
 *   3. Default: the prod old-site URL.
 * SSR and hydration read the same env → same value → no hydration mismatch.
 */
export const LEGACY_MIGRACAO_URL: string =
  (typeof window !== 'undefined' && window.__EUNENEM_ENV__?.legacyMigracaoUrl) ||
  (typeof process !== 'undefined' && process.env.LEGACY_MIGRACAO_URL) ||
  'https://eunenem.com/migracao';

/**
 * aperture-rurre — NOVA LISTA V1 create mutation.
 *
 * aperture-1yx1n — the rurre-era TrpcCriarShim is GONE (x0unf merged long
 * ago; campanhas.criar is real on the router). Plain inference now, which
 * also hands onSuccess the created campanha DTO — the setup wizard opens
 * with it (§1.5).
 */
export function useCampanhasCriar(opts?: {
  onSuccess?: (data: { id: string; titulo: string }) => void;
  onError?: () => void;
}) {
  return trpc.campanhas.criar.useMutation(opts);
}

export function useCampanhasList() {
  return trpc.campanhas.list.useQuery(undefined, { staleTime: 30_000 });
}

/**
 * aperture-1yx1n — the ROUTE campanha's user-chosen slug, when it has one.
 * Feeds the pretty /pagina/<slug>/<campanhaSlug> share form; undefined =
 * bare route, unknown id, list not loaded, or slug not chosen — consumers
 * fall back to the /c/<uuid> canonical form. (Real DTO field post-#359.)
 */
export function useCampanhaSlugRota(): string | undefined {
  const idCampanhaRota = useCampanhaRota();
  // aperture-2v91z (Wheatley's gotcha) — BARE routes resolve the DEFAULT
  // campanha (auth.me) so the share chip shows ITS slug too; /c/:id-gating
  // alone left every bare painel un-addressed even when the default
  // campanha had a chosen slug.
  const meQ = trpc.auth.me.useQuery(undefined, {
    staleTime: 30_000,
    enabled: !idCampanhaRota,
  });
  const idCampanha = idCampanhaRota ?? meQ.data?.idCampanha ?? undefined;
  const listQ = trpc.campanhas.list.useQuery(undefined, {
    staleTime: 30_000,
    enabled: Boolean(idCampanha),
  });
  if (!idCampanha) return undefined;
  const card = listQ.data?.novas.find((c) => c.id === idCampanha);
  return card?.campanhaSlug ?? undefined;
}
