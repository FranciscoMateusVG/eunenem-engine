/**
 * aperture-n1b34 — tRPC transport must never be answered by the HTTP cache.
 *
 * Root cause of "the painel tutorial reopens every time I come back": tRPC
 * queries travel as batched GETs (`/api/trpc/a,b,usuario.tutorialStatus?…`).
 * On a history navigation (browser Back/Forward, `performance` type
 * `back_forward`) Chromium answers same-URL subresource fetches issued during
 * page load FROM DISK CACHE without revalidating — so the painel rehydrated
 * the pre-ENCERRAR body (`completado:false`) although the mutation had long
 * since persisted `completado:true` (reload and direct re-entry were correct;
 * only Back was stale). Verified at the artifact layer with CDP
 * `Network.responseReceived.fromDiskCache === true` on the Back leg.
 *
 * `cache: 'no-store'` on every tRPC request makes the browser bypass the HTTP
 * cache regardless of navigation type. Session-scoped data (auth.me, tutorial
 * status, perfil…) has no business in a shared HTTP cache anyway. Purely a
 * client transport concern: no endpoint, schema or server change.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wrap a fetch so every call carries `cache: 'no-store'`, preserving
 * everything else tRPC put on the init (method, headers, body, signal).
 * A caller-supplied `cache` is deliberately overridden — the whole point is
 * that no tRPC request can opt back into the HTTP cache.
 */
export function noStoreFetch(baseFetch?: FetchLike): FetchLike {
  return (input, init) => {
    // Resolve at call time so the global `fetch` of the CURRENT runtime is used
    // (browser on the client; Node's on the server — which never fires today,
    // see TrpcProvider's SSR note).
    const impl = baseFetch ?? globalThis.fetch;
    return impl(input, { ...init, cache: 'no-store' });
  };
}
