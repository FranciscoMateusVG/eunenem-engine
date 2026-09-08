import type { MiddlewareHandler } from "hono";
import { resolveRoute } from "../pages/App.js";

const LEGACY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Mirrors legacy origin/main src/lib/validations/utm.ts: 3–50 ASCII
// alphanumeric/hyphen characters, alphanumeric at both ends, no "--".
// The legacy write schema lowercases new values, but uppercase remains an
// accepted input shape and is preserved here rather than rewritten.
const LEGACY_CUSTOM_SLUG = /^(?!.*--)[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i;

// Engine namespaces win even when the remainder of the path is invalid.
// This prevents a typo below an Engine surface from being reinterpreted as
// a legacy guest page.
const ENGINE_RESERVED_NAMESPACES = new Set([
  "admin",
  "api",
  "assets",
  "auth",
  "auth-demo",
  "campanhas",
  "faq",
  "healthz",
  "listas-prontas",
  "pagina",
  "painel",
  "products",
  "public",
  "termos-de-uso",
  "trpc-smoke",
]);

export function isEligibleLegacyGuestPath(pathname: string): boolean {
  if (resolveRoute(pathname).kind !== "not-found") return false;

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return false;

  const identifier = segments[0];
  if (!identifier || ENGINE_RESERVED_NAMESPACES.has(identifier.toLowerCase())) {
    return false;
  }
  if (segments.length === 2 && segments[1] !== "checkout") return false;

  return LEGACY_UUID.test(identifier) || LEGACY_CUSTOM_SLUG.test(identifier);
}

function configuredLegacyOrigin(
  rawOrigin: string | undefined,
  requestOrigin: string,
): string | null {
  const value = rawOrigin?.trim();
  if (!value) return null;

  try {
    const configured = new URL(value);
    const current = new URL(requestOrigin);
    if (configured.protocol !== "https:" && configured.protocol !== "http:") {
      return null;
    }
    if (
      configured.username ||
      configured.password ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash
    ) {
      return null;
    }
    // Reject the current public host regardless of a scheme typo. The redirect
    // must cross to a dedicated legacy host, never point back at this app.
    if (configured.hostname.toLowerCase() === current.hostname.toLowerCase()) {
      return null;
    }
    return configured.origin;
  } catch {
    return null;
  }
}

export function resolveLegacyGuestRedirect(args: {
  method: string;
  requestUrl: string;
  legacySiteOrigin: string | undefined;
}): string | null {
  if (args.method !== "GET" && args.method !== "HEAD") return null;

  const request = new URL(args.requestUrl);
  if (!isEligibleLegacyGuestPath(request.pathname)) return null;

  const legacyOrigin = configuredLegacyOrigin(
    args.legacySiteOrigin,
    request.origin,
  );
  if (!legacyOrigin) return null;

  return `${legacyOrigin}${request.pathname}${request.search}`;
}

export function createLegacyGuestRedirectMiddleware(
  legacySiteOrigin: string | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const destination = resolveLegacyGuestRedirect({
      method: c.req.method,
      requestUrl: c.req.url,
      legacySiteOrigin,
    });
    if (!destination) return next();

    c.header("Cache-Control", "no-store");
    return c.redirect(destination, 302);
  };
}
