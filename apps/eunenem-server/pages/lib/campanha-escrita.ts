/**
 * aperture-1kbyx (fblrt W2 precondition) — WRITE-path campanha resolution.
 *
 * Reads default to the oldest campanha server-side forever (by design), but
 * the 11 authed WRITE mutations are flipping to REQUIRED idCampanha (Rex's
 * 48mxt enforcement). This hook is the single choke point that makes the flip
 * safe: on a bare /painel/:slug URL it resolves the session default
 * (auth.me.idCampanha — the user's oldest campanha id, already
 * client-available) so every authed write sends an EXPLICIT id.
 *
 * Guardrails (Wheatley, b8c8u decomposition):
 *   (a) precedence is `rotaId ?? me.idCampanha` — the /c/:id route context
 *       ALWAYS wins; the me-default must never shadow a clicked campanha.
 *   (b) an account with NO campanha (me.idCampanha null) returns undefined —
 *       callers keep their conditional spread and send NOTHING, letting the
 *       server's REQUIRED error surface honestly. We never invent an id.
 *
 * Cold-cache note: on a bare URL, if auth.me hasn't resolved yet this returns
 * undefined and the write omits the id. In practice every painel surface
 * gates its interactive UI on auth.me loading, so the cache is warm before
 * any write can fire; while the server keeps idCampanha optional (this
 * additive step) the omission is also fully backward-safe.
 */
import { useCampanhaRota } from './campanha-rota.js';
import { trpc } from './trpc.js';

/**
 * The campanha id every authed WRITE should address: the route's /c/:id when
 * present, otherwise the session-default (oldest) campanha, otherwise
 * undefined (no-campanha edge — send nothing).
 */
export function useCampanhaEscrita(): string | undefined {
  const rotaId = useCampanhaRota();
  const meQ = trpc.auth.me.useQuery(undefined, {
    staleTime: 30_000,
    enabled: !rotaId,
  });
  return rotaId ?? meQ.data?.idCampanha ?? undefined;
}

/**
 * aperture-48mxt (W2 enforce) — the 11 authed write mutations now REQUIRE
 * idCampanha at the wire; this hook injects it, so the wrapper hooks expose
 * an input type WITHOUT the field (components never supply it). The no-
 * campanha edge (me.idCampanha null — zero rows in prod) sends an empty
 * sentinel: it can never address anything and fails uuid validation with the
 * same honest BAD_REQUEST the old omission produced. We still never invent
 * a real id (guardrail b).
 */
export type SemIdCampanha<F> = F extends (input: infer I, ...rest: infer R) => infer Ret
  ? (input: Omit<I, 'idCampanha'>, ...rest: R) => Ret
  : never;
