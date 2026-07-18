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
    /** Runtime config injected by server.tsx's envelope() (aperture-pjd74 +
     *  aperture-gejcw). Both keys are whitelisted in serializeRuntimeEnv. */
    __EUNENEM_ENV__?: { legacyMigracaoUrl?: string; legacySiteOrigin?: string };
  }
}

function runtimeEnv(
  key: 'legacyMigracaoUrl' | 'legacySiteOrigin',
): string | undefined {
  const win =
    typeof window !== 'undefined' ? window.__EUNENEM_ENV__?.[key] : undefined;
  const proc =
    typeof process !== 'undefined'
      ? key === 'legacyMigracaoUrl'
        ? process.env.LEGACY_MIGRACAO_URL
        : process.env.LEGACY_SITE_ORIGIN
      : undefined;
  const v = (win || proc || '').trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Where the 1.0 card points (aperture-gejcw — domain-swap env-drive). Derived
 * from the ONE canonical legacy var so a cutover is config-only:
 *   1. LEGACY_MIGRACAO_URL — explicit override (runtime whitelist or SSR env).
 *      Wins when set; keeps back-compat with the current Dokploy config.
 *   2. LEGACY_SITE_ORIGIN + '/migracao' — the derived default.
 *   3. null — no legacy origin resolvable. FAIL-LOUD: NO hardcoded eunenem.com
 *      fallback (it would self-loop after the swap). Prod can't reach here (the
 *      boot guard requires LEGACY_SITE_ORIGIN); dev/test hides the card instead.
 * SSR and hydration read the same env → same value → no hydration mismatch.
 */
export const LEGACY_MIGRACAO_URL: string | null = (() => {
  const override = runtimeEnv('legacyMigracaoUrl');
  if (override) return override;
  const origin = runtimeEnv('legacySiteOrigin');
  return origin ? `${origin.replace(/\/+$/, '')}/migracao` : null;
})();

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
 * Shared resolution: the ROUTE campanha's card from `campanhas.list`
 * (bare URL → the session's DEFAULT campanha via `auth.me`; /c/:id → that
 * campanha). Underlies both `useCampanhaSlugRota` (existing consumers) and
 * `useCampanhaSlugInfoRota` (adds `slugJaAlterado` for PerfilBody's 1-troca
 * gate) so the two never drift on how `idCampanha` is resolved.
 */
function useCampanhaCardRota(): CampanhaNovaDTO | undefined {
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
  return listQ.data?.novas.find((c) => c.id === idCampanha);
}

/**
 * aperture-1yx1n — the ROUTE campanha's user-chosen slug, when it has one.
 * Feeds the pretty /pagina/<slug>/<campanhaSlug> share form; undefined =
 * bare route, unknown id, list not loaded, or slug not chosen — consumers
 * fall back to the /c/<uuid> canonical form. (Real DTO field post-#359.)
 */
export function useCampanhaSlugRota(): string | undefined {
  return useCampanhaCardRota()?.campanhaSlug ?? undefined;
}

/**
 * aperture — 1-troca. The ROUTE campanha's own slug + whether it has
 * already used its single allowed change via PerfilBody's SlugEditor.
 * `slugJaAlterado` defaults to `false` while the list is still loading —
 * the editor stays visible rather than flashing hidden-then-shown.
 */
export function useCampanhaSlugInfoRota(): {
  campanhaSlug: string | undefined;
  slugJaAlterado: boolean;
} {
  const card = useCampanhaCardRota();
  return {
    campanhaSlug: card?.campanhaSlug ?? undefined,
    slugJaAlterado: card?.slugJaAlterado ?? false,
  };
}
