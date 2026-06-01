/**
 * Admin tenant scope — client-safe re-declaration of the engine const.
 *
 * The canonical source is `ID_PLATAFORMA_EUNENEM` in
 * `engine/src/adapters/plataforma/repository.memory.ts`. Pulling that
 * symbol into the client bundle drags in `@opentelemetry/api`,
 * `node:crypto`, etc. — heavy engine deps the browser can't resolve.
 *
 * App.tsx already establishes this duplication pattern (see SLUG_REGEX
 * with the same caveat). The literal value MUST stay in lockstep with
 * the engine const; if the engine constant ever changes, update this
 * file too.
 *
 * v1 is single-tenant. Every admin query is implicitly scoped to this
 * plataforma. Multi-tenancy is deferred to v2; when it lands, this
 * constant goes away and tenant scope comes from the auth context.
 *
 * SSR side (server.tsx) imports the real constant from engine's index
 * directly; no duplication risk there because server bundles include
 * Node-only modules. This shim is exclusively for pages/* code that
 * gets bundled into the browser.
 */
export const ADMIN_PLATAFORMA_ID =
  "11111111-1111-4111-8111-111111111111" as const;

export type AdminPlataformaId = typeof ADMIN_PLATAFORMA_ID;
