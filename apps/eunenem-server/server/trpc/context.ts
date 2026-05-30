import type { ServerDeps } from '../auth/setup.js';

/**
 * tRPC request context (aperture-ht7sq). Carries the shared engine deps +
 * the per-request `headers` (needed for cookie reads in `auth.me` and
 * `auth.signOut`) + `resHeaders` (where procedures can write Set-Cookie
 * for `auth.signUp` / `auth.signIn`).
 *
 * Built once per request by `createContext` in server.tsx. Procedures
 * destructure `{ deps, headers, resHeaders }` from `ctx`.
 */
export interface TrpcContext {
  readonly deps: ServerDeps;
  readonly headers: Headers;
  readonly resHeaders: Headers;
}
