/**
 * Legacy bridge (aperture-as0v3, epic aperture-7hm2g) — SILENT login handoff
 * from the new EuNeném 2.0 site into the legacy 1.0 system (eunenem.com, Clerk).
 *
 * FLOW: an authenticated /campanhas 1.0-card click hits GET /api/legacy-bridge.
 * We mint a single-use Clerk sign-in token for the matching legacy user and
 * 302 to `https://eunenem.com/ponte?__clerk_ticket=<token>`, where Clerk's
 * prebuilt <SignIn/> consumes it and lands the user on /minha-area LOGGED IN —
 * no second login, no jarring redirect to the old login page.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL (Cipher hard-gate, aperture-92oax — this endpoint MINTS
 * logins into the OLD system from NEW-system auth, so the trust chain is
 * load-bearing):
 *
 *  TRUST ANCHOR = users.email_verified === true. NOT "has a session".
 *    emailAndPassword signup is enabled with NO verification flow, so a
 *    password signup has email_verified=FALSE and proves NOTHING about inbox
 *    ownership. Most 1.0 users never registered on the new site, so without
 *    this gate an attacker could register victim@x.com + any password, get a
 *    session whose email == the victim's, and mint a Clerk ticket into the
 *    victim's OLD account = one-click cross-system takeover. email_verified is
 *    true ONLY via the ownership-proving paths (Google trusted+verified,
 *    Microsoft via the uq69m predicate, magic-link verify) — that IS the
 *    anchor. Password-only sessions fall back to the plain redirect (Clerk
 *    makes them log in the old way — today's live behavior, no regression).
 *    Reinforced by the qcrv4/79b31 invariant: a verified-email user cannot
 *    retain a live credential password, and (aperture-as0v3 hardening) their
 *    pre-existing sessions are revoked the instant that password dies — so a
 *    verified session can never be a password-squatter's.
 *
 *  CLERK MATCH must be verification.status === 'verified' on the matched
 *    email address; ZERO verified → fallback; MULTIPLE users / multiple
 *    verified matches → FAIL CLOSED to fallback + WARN (never pick-first).
 *
 *  CLERK_SECRET_KEY is a RUNTIME server env (process.env via Dokploy) — NEVER
 *    a build-time esbuild define (that inlines sk_live into the CLIENT bundle =
 *    full old-site user-admin API leaked). Never logged, never in BEADS.
 *
 *  The 1.0-card gating (legacy-1.0-users.json) is NOT a security control — this
 *    endpoint is directly callable by any authenticated user. It's safe only
 *    because the mint is SELF-ONLY (we mint for the caller's OWN verified
 *    email, never an email from the request). Do not later lean on card-gating
 *    as a security boundary.
 *
 *  Token: expires_in_seconds=60, single-use (Clerk enforces). Consumption URL
 *    is a server-side constant — no return_to / redirect param is read from the
 *    request, so there is no open-redirect surface. Per-user mint rate-limit
 *    reuses the rate_limit table (magic-link precedent). Every outcome is
 *    logged with a hashed email — never the token.
 *
 *  FAIL-OPEN TO FALLBACK, NEVER TO AN ERROR PAGE: a 1.0-card click must always
 *    end somewhere useful. Every non-mint branch (no session, unverified, no
 *    key, no Clerk user, ambiguous match, Clerk error, rate-limited) 302s to
 *    the legacy dashboard (or "/" for no-session) — the pre-bridge POC behavior.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { hashClientPII } from '../../../src/index.js';
import type { ServerDeps } from './auth/setup.js';
import { trustedClientIp } from './lib/security/trusted-client-ip.js';
import {
  resolverUsuarioAutenticado,
  SessaoNaoAutenticadaError,
} from './trpc/session-resolver.js';

/** Legacy site origin. Overridable via env for a non-prod consumption target. */
const LEGACY_ORIGIN = process.env.LEGACY_SITE_ORIGIN ?? 'https://eunenem.com';
/** Where an authed-but-unminted click lands — today's live POC behavior. */
const FALLBACK_URL = `${LEGACY_ORIGIN}/minha-area`;
/** Ticket consumption route on the old site (aperture-rj2rg). Hardcoded — no
 * request-controlled redirect target (open-redirect defence). */
const CONSUMPTION_PATH = '/ponte';
/** Clerk sign-in token TTL. Short — the redirect consumes it immediately. */
const SIGN_IN_TOKEN_TTL_SECONDS = 60;
/** Clerk Backend API base. */
const CLERK_API_BASE = 'https://api.clerk.com/v1';
/** Per-user mint budget (reuses the rate_limit table; magic-link precedent). */
const MINT_WINDOW_MS = 60 * 1000;
const MINT_MAX_PER_WINDOW = 5;
/** Outbound Clerk call timeout — a slow legacy dependency must not hang the
 * click; on timeout we fall back. */
const CLERK_TIMEOUT_MS = 4000;

/** Distinct outcomes, all logged (no free-form strings — greppable). */
type BridgeOutcome =
  | 'sem_sessao'
  | 'nao_verificado'
  | 'sem_chave'
  | 'sem_usuario_clerk'
  | 'clerk_ambiguo'
  | 'mintado'
  | 'erro_clerk'
  | 'rate_limited';

/**
 * Result of resolving a legacy email to a Clerk user. `ambiguous` is a
 * fail-closed signal (>1 user, or >1 verified address) — never pick-first.
 */
type ClerkLookup =
  | { readonly kind: 'found'; readonly userId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

/**
 * Minimal Clerk Backend API seam. Real impl does authed fetch; tests inject a
 * fake so no test touches the network or needs sk_live.
 */
export interface ClerkBridgeClient {
  /** Find a user whose given email address is VERIFIED. */
  findVerifiedUserByEmail(email: string): Promise<ClerkLookup>;
  /** Mint a single-use sign-in token for the user. Returns the raw token. */
  mintSignInToken(userId: string): Promise<string>;
}

/** Narrow shape of the Clerk user objects we read. */
interface ClerkEmailAddress {
  readonly email_address?: unknown;
  readonly verification?: { readonly status?: unknown } | null;
}
interface ClerkUser {
  readonly id?: unknown;
  readonly email_addresses?: readonly ClerkEmailAddress[];
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLERK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real Clerk Backend API client. Only constructed when CLERK_SECRET_KEY is
 * present. `secret` is captured in the closure — never stored on an object a
 * log or serializer could reach.
 */
export function criarClerkBridgeClient(secret: string): ClerkBridgeClient {
  const authHeader = { Authorization: `Bearer ${secret}` } as const;
  return {
    async findVerifiedUserByEmail(email: string): Promise<ClerkLookup> {
      // Clerk matches email_address regardless of verification; we filter to
      // verified ourselves (a Clerk match on an UNVERIFIED address is not proof
      // the caller owns that Clerk identity).
      const url = `${CLERK_API_BASE}/users?email_address=${encodeURIComponent(email)}`;
      const res = await fetchWithTimeout(url, { headers: authHeader });
      if (!res.ok) throw new Error(`clerk users lookup ${res.status}`);
      const body = (await res.json()) as unknown;
      const users: readonly ClerkUser[] = Array.isArray(body) ? (body as ClerkUser[]) : [];
      const target = email.trim().toLowerCase();

      const matches = users.filter((u) =>
        (u.email_addresses ?? []).some(
          (e) =>
            typeof e.email_address === 'string' &&
            e.email_address.trim().toLowerCase() === target &&
            e.verification?.status === 'verified',
        ),
      );
      if (matches.length === 0) return { kind: 'none' };
      // >1 user sharing a verified copy of this email → we cannot safely pick
      // one. Fail closed (Cipher: never pick-first).
      if (matches.length > 1) return { kind: 'ambiguous' };
      const only = matches[0];
      return typeof only?.id === 'string' && only.id.length > 0
        ? { kind: 'found', userId: only.id }
        : { kind: 'none' };
    },

    async mintSignInToken(userId: string): Promise<string> {
      const res = await fetchWithTimeout(`${CLERK_API_BASE}/sign_in_tokens`, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: userId, expires_in_seconds: SIGN_IN_TOKEN_TTL_SECONDS }),
      });
      if (!res.ok) throw new Error(`clerk sign_in_tokens ${res.status}`);
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== 'string' || body.token.length === 0) {
        throw new Error('clerk sign_in_tokens: no token in response');
      }
      return body.token;
    },
  };
}

/**
 * Per-user mint budget over the rate_limit table (durable, multi-instance;
 * same table + posture as the magic-link per-email shield). Fail-closed on a
 * storage error → treat as over-budget → fallback redirect (never an unbounded
 * mint path). Returns true when a mint is within budget.
 */
async function consumeMintBudget(deps: ServerDeps, idUsuario: string): Promise<boolean> {
  const key = `legacy-bridge-mint:${idUsuario}`;
  const now = Date.now();
  try {
    const row = await deps.db
      .selectFrom('rate_limit')
      .select(['count', 'last_request'])
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) {
      await deps.db
        .insertInto('rate_limit')
        .values({ id: randomUUID(), key, count: 1, last_request: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ count: 1, last_request: now }))
        .execute();
      return true;
    }
    if (now - Number(row.last_request) > MINT_WINDOW_MS) {
      await deps.db
        .updateTable('rate_limit')
        .set({ count: 1, last_request: now })
        .where('key', '=', key)
        .execute();
      return true;
    }
    if (row.count >= MINT_MAX_PER_WINDOW) return false;
    await deps.db
      .updateTable('rate_limit')
      .set({ count: row.count + 1, last_request: now })
      .where('key', '=', key)
      .execute();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the BetterAuth `users.email_verified` for the resolved user. The
 * session-resolver returns the domain usuario (id + email) but the verification
 * STATE lives on the auth table — the gate reads it directly, same source the
 * qcrv4/79b31 hooks key on. Fail-closed: any read problem → treated as
 * unverified.
 */
async function emailVerificado(deps: ServerDeps, idUsuario: string): Promise<boolean> {
  try {
    const row = await deps.db
      .selectFrom('users')
      .select('email_verified')
      .where('id', '=', idUsuario)
      .executeTakeFirst();
    return row?.email_verified === true;
  } catch {
    return false;
  }
}

function redirect(c: Context, location: string): Response {
  return c.redirect(location, 302);
}

/**
 * Factory for the GET /api/legacy-bridge handler. `clerkFactory` is injectable
 * for tests (defaults to the real client built from CLERK_SECRET_KEY at request
 * time). When no key is configured the endpoint degrades to the plain fallback
 * redirect — boots clean in every environment (same conditional-registration
 * posture as the OAuth/SMTP gates).
 */
export function createLegacyBridgeHandler(
  deps: ServerDeps,
  clerkFactory: (secret: string) => ClerkBridgeClient = criarClerkBridgeClient,
) {
  const { logger } = deps.observability;

  return async (c: Context): Promise<Response> => {
    const headers = c.req.raw.headers;
    // Client identifiers captured once, hashed (PII), reused across every exit
    // branch so the structured log carries the same trail regardless of outcome
    // (Cipher checklist #11: user_id, hashed email, clerk_user_id, IP, UA, ts,
    // outcome — the token NEVER appears).
    const ipHashed = hashClientPII(
      trustedClientIp(headers, deps.trustedHopCount),
      deps.logPiiHashSalt,
    );
    const userAgent = headers.get('user-agent') ?? '';
    const log = (outcome: BridgeOutcome, extra: Record<string, unknown> = {}) =>
      logger.info('eunenem.legacy_bridge', { outcome, ipHashed, userAgent, ...extra });

    // 1. AUTH — via the shared resolver (A2 + orphan-heal), never a bare cookie.
    let idUsuario: string;
    let email: string;
    try {
      const { usuario } = await resolverUsuarioAutenticado(deps, headers);
      idUsuario = usuario.id;
      email = usuario.email;
    } catch (err) {
      if (err instanceof SessaoNaoAutenticadaError) {
        log('sem_sessao');
        // No session → home, not the legacy dashboard (don't hand an old-site
        // URL to an anonymous prober).
        return redirect(c, '/');
      }
      throw err;
    }

    const emailHash = hashClientPII(email, deps.logPiiHashSalt);

    // 2. TRUST GATE — verified email only (the whole security model).
    if (!(await emailVerificado(deps, idUsuario))) {
      log('nao_verificado', { idUsuario, emailHash });
      return redirect(c, FALLBACK_URL);
    }

    // 3. KEY — absent → silent fallback (endpoint inert without sk).
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret || secret.length === 0) {
      log('sem_chave', { idUsuario, emailHash });
      return redirect(c, FALLBACK_URL);
    }

    // 4. RATE-LIMIT the mint per user.
    if (!(await consumeMintBudget(deps, idUsuario))) {
      log('rate_limited', { idUsuario, emailHash });
      return redirect(c, FALLBACK_URL);
    }

    // 5. RESOLVE + MINT. Any Clerk error → fallback (never an error page).
    try {
      const clerk = clerkFactory(secret);
      const lookup = await clerk.findVerifiedUserByEmail(email);
      if (lookup.kind === 'none') {
        log('sem_usuario_clerk', { idUsuario, emailHash });
        return redirect(c, FALLBACK_URL);
      }
      if (lookup.kind === 'ambiguous') {
        // >1 verified Clerk user for this email — never guess which legacy
        // account to log into. Fallback + loud (Cipher: fail closed + alert).
        logger.warn('eunenem.legacy_bridge.ambiguous_clerk_match', { idUsuario, emailHash });
        log('clerk_ambiguo', { idUsuario, emailHash });
        return redirect(c, FALLBACK_URL);
      }
      const token = await clerk.mintSignInToken(lookup.userId);
      log('mintado', { idUsuario, emailHash, clerkUserId: lookup.userId });
      // NEVER log the token. Single-use + 60s; the old-site /ponte consumes it.
      const url = `${LEGACY_ORIGIN}${CONSUMPTION_PATH}?__clerk_ticket=${encodeURIComponent(token)}`;
      return redirect(c, url);
    } catch (err) {
      log('erro_clerk', {
        idUsuario,
        emailHash,
        erro: err instanceof Error ? err.message : String(err),
      });
      return redirect(c, FALLBACK_URL);
    }
  };
}
