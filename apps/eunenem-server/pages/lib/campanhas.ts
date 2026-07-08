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
 * Where the 1.0 card actually points (aperture-pjd74, supersedes the silent
 * bridge from aperture-as0v3 — operator pivot 2026-07-08). The old site's
 * dedicated /migracao explainer page: sets the expectation that 1.0 and 2.0
 * are separate systems ("você precisa fazer login de novo"), then a Clerk
 * modal login → /minha-area (email-resolved 1.0 panel). The bridge endpoint
 * stays registered but inert (cleanup tracked separately). Izzy's E2E
 * (aperture-8jcec) asserts the anchor + this href — imported there so spec +
 * test move together.
 */
export const LEGACY_MIGRACAO_URL = 'https://eunenem.com/migracao';

/**
 * aperture-rurre — NOVA LISTA V1 create mutation.
 *
 * INTEGRATION SHIM (same pattern the list hook used pre-#320): Rex's
 * campanhas.criar mutation ships in his parallel PR (aperture-x0unf,
 * contract: authed, input {titulo} only — no slug/recebedor/perfil in V1).
 * Until it merges, AppRouter has no `criar` key, so this reaches through
 * the runtime proxy via one structurally-typed cast. When his PR lands,
 * delete TrpcCriarShim and inline trpc.campanhas.criar.useMutation.
 */
type TrpcCriarShim = {
  campanhas: {
    criar: {
      useMutation: (opts?: {
        onSuccess?: () => void;
        onError?: () => void;
      }) => {
        mutate: (input: { titulo: string }) => void;
        isPending: boolean;
      };
    };
  };
};

export function useCampanhasCriar(opts?: {
  onSuccess?: () => void;
  onError?: () => void;
}) {
  const shim = trpc as unknown as TrpcCriarShim;
  return shim.campanhas.criar.useMutation(opts);
}

export function useCampanhasList() {
  return trpc.campanhas.list.useQuery(undefined, { staleTime: 30_000 });
}
