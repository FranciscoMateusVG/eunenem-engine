import {
  provisionarContaUsuarioDominio,
  UsuarioEmailJaExisteError,
} from '../../../../src/index.js';
import type { IdUsuario, Usuario } from '../../../../src/index.js';
import type { ServerDeps } from '../auth/setup.js';

/**
 * Central session resolution + OAuth orphan self-heal (aperture-6wo1f).
 *
 * THE shared layer every authed tRPC router resolves sessions through. It
 * exists to fix two coupled production bugs and to keep their fix ATOMIC
 * across all routers (Cipher's invariant — see below):
 *
 *   BUG A (cookie read). The tRPC signUp/signIn procedures set the BARE
 *   cookie name `better-auth.session_token` (unsigned, the engine session
 *   token). But BetterAuth's OAuth HTTP flow under `useSecureCookies=true`
 *   (prod) sets a `__Secure-`-PREFIXED, HMAC-SIGNED cookie. A bare-name
 *   string match MISSES it → OAuth users resolved to "no session" → landed
 *   logged-out. Fix (A2): when the bare path yields no live session, FALL
 *   BACK to BetterAuth's PROGRAMMATIC `auth.api.getSession({ headers })` (a
 *   direct function call, NOT the HTTP /api/auth/get-session route). It
 *   natively resolves the `__Secure-` name + verifies the HMAC + looks up the
 *   session — NO hand-rolled crypto.
 *
 *   BUG B (orphan domain user). BetterAuth's NATIVE create (OAuth) writes only
 *   users/sessions/accounts — never the engine `usuarios`/`contas`/`campanhas`
 *   domain rows (only the email+password saga creates those). So a freshly
 *   OAuth-authenticated user resolves to a valid session whose `usuarios` row
 *   is MISSING. Fix: idempotently self-heal — provision the domain side by
 *   REUSING the saga's extracted domain logic (`provisionarContaUsuarioDominio`,
 *   NOT a reimplementation), then re-read.
 *
 * ── ATOMICITY INVARIANT (Cipher, mandatory) ───────────────────────────────
 * A2 and the heal MUST land together. Before this module, the ~7 inline
 * routers read the BARE cookie name and so MISSED the OAuth cookie — that
 * accidental "can't read it → fail-closed" was the ONLY thing keeping them from
 * acting on an orphan. The moment A2 lets a router understand the OAuth cookie,
 * orphan-safety MUST come from the heal-or-fail-close HERE, not from the
 * routers' former inability to read the cookie. Therefore the raw A2 resolver
 * (`resolverSessao`) is module-PRIVATE and is NEVER exported: the only ways out
 * of this module are `resolverUsuarioAutenticado` (A2 + heal, fused) and its
 * null-returning sibling. No caller can obtain an A2-resolved session without
 * the heal-or-fail-close running. Structurally enforced, not convention.
 */

/**
 * A resolved session principal. `idUsuario` + `expiraEm` are always present.
 * `principal` carries the fields needed to self-heal an orphan and is present
 * ONLY on the getSession/OAuth path — the bare-cookie (email+password) path
 * never needs it because those users always have a `usuarios` row from the
 * signup saga, so the heal branch is never reached for them.
 */
interface SessaoResolvida {
  readonly idUsuario: string;
  readonly expiraEm: Date;
  readonly principal: {
    readonly idPlataforma: string;
    readonly email: string;
    readonly nome: string;
  } | null;
}

/**
 * Sentinel thrown when no live session resolves OR when an orphan heal fails
 * (fail-closed). Defined in THIS module so `instanceof` is stable across the
 * apps/eunenem-server ↔ root-tests module boundary (unlike `@trpc/server`'s
 * TRPCError, which the test runner resolves from a divergent location — see the
 * router files' own notes). Each router maps this to its existing UNAUTHORIZED
 * shape, preserving its error contract.
 */
export class SessaoNaoAutenticadaError extends Error {
  public readonly name = 'SessaoNaoAutenticadaError';
  constructor(public readonly motivo: 'sem_sessao' | 'orfao_heal_falhou') {
    super(motivo);
  }
}

/**
 * Parse the session token from the Cookie header (the bare cookie name the
 * tRPC procedures set). Same logic as Hono's getCookie, inlined because the
 * tRPC context only carries the raw Headers object.
 */
export function readSessionCookie(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const target = `${name}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(target)) {
      return decodeURIComponent(cookie.slice(target.length));
    }
  }
  return null;
}

/**
 * Resolve via BetterAuth's programmatic `getSession`. Handles the prod OAuth
 * `__Secure-`/HMAC-signed cookie the bare read can't see. Fail-closed: returns
 * null when getSession throws (malformed/forged cookie, signature mismatch, or
 * — in tests where `deps.auth` is a stub — a TypeError on the missing api) or
 * when it resolves no session.
 *
 * `idPlataforma` comes from the resolved BetterAuth `user` object's
 * `id_plataforma` additionalField (the server constant set by the dm7s3
 * create-hook), NEVER anything user-controllable (Cipher #1). If it is somehow
 * absent we fail-closed rather than provision into an undefined tenant.
 */
async function resolverViaGetSession(
  deps: ServerDeps,
  headers: Headers,
): Promise<SessaoResolvida | null> {
  let result: Awaited<ReturnType<typeof deps.auth.api.getSession>>;
  try {
    result = await deps.auth.api.getSession({ headers });
  } catch {
    return null;
  }
  if (!result) return null;

  const { user, session } = result;
  const idPlataforma = (user as { idPlataforma?: unknown }).idPlataforma;
  if (typeof idPlataforma !== 'string' || idPlataforma.length === 0) {
    return null;
  }
  return {
    idUsuario: user.id,
    expiraEm: session.expiresAt,
    principal: { idPlataforma, email: user.email, nome: user.name },
  };
}

/**
 * A2 session resolution (module-PRIVATE — never exported; see the atomicity
 * invariant above). PATH 1 is the bare-cookie email+password posture: the
 * engine session is the source of truth, `validarSessao` yields idUsuario +
 * expiraEm directly, and the full domain user comes from `findUsuarioById`
 * downstream — so NO getSession round-trip is needed (and email+password must
 * not depend on getSession, which can't resolve the bare unsigned cookie).
 * PATH 2 is the OAuth fallback.
 */
async function resolverSessao(
  deps: ServerDeps,
  headers: Headers,
): Promise<SessaoResolvida | null> {
  // PATH 1 — bare cookie (email+password). Source of truth = engine session.
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (token) {
    try {
      const sessao = await deps.authService.validarSessao(token as never);
      if (sessao) {
        return { idUsuario: sessao.idUsuario, expiraEm: sessao.expiraEm, principal: null };
      }
    } catch {
      // Malformed token (fails TokenSessaoSchema.parse) — treat as no bare
      // session and fall through to the programmatic OAuth fallback.
    }
  }

  // PATH 2 — BetterAuth programmatic fallback (prod OAuth __Secure-/signed cookie).
  return resolverViaGetSession(deps, headers);
}

/**
 * Self-heal provisioning (BUG B). Given the OAuth orphan's provisioning
 * principal, IDEMPOTENTLY provision the domain side by REUSING the saga's
 * extracted domain logic, then return the now-existing Usuario.
 *
 * Cipher constraints, by construction:
 *   #1 TENANT — `idPlataforma` is the resolved session user's server-constant
 *      `users.id_plataforma`, passed straight through. Never from the Google
 *      profile / request / anything user-controllable.
 *   #2 LEAST-PRIVILEGE — PERMISSOES_PADRAO via the reused fn (no alternate set).
 *   #3 FAIL-CLOSED — any provisioning failure throws; the caller maps that to
 *      UNAUTHORIZED / null, NEVER a partial-privilege user.
 *   #4 UNIQUE-BACKSTOP + idempotent — a concurrent resolve may provision first;
 *      that makes the domain save raise the `(id_plataforma,email)` UNIQUE →
 *      `UsuarioEmailJaExisteError`. We CATCH it and re-read `findUsuarioById`,
 *      returning the now-existing user (no error, no duplicate). Only genuinely
 *      -missing usuarios are provisioned; the heal is never invoked unless
 *      `findUsuarioById` already returned undefined.
 */
async function autoProvisionarUsuarioOrfao(
  deps: ServerDeps,
  idUsuario: string,
  principal: NonNullable<SessaoResolvida['principal']>,
): Promise<Usuario> {
  try {
    const resultado = await provisionarContaUsuarioDominio(
      {
        usuarioRepository: deps.usuarioRepository,
        plataformaRepository: deps.plataformaRepository,
        campanhaRepository: deps.campanhaRepository,
        recebedorRepository: deps.recebedorRepository,
        clock: deps.clock,
        observability: deps.observability,
      },
      {
        idUsuario,
        idPlataforma: principal.idPlataforma,
        email: principal.email,
        nome: principal.nome,
        // idConta omitted — the provisioner mints one (OAuth self-heal has no
        // caller-supplied idConta; the email+password saga passes its own).
      },
    );
    return resultado.usuario;
  } catch (err) {
    // Concurrent-double-provision race (Cipher #4): another in-flight resolve
    // already provisioned → the UNIQUE backstop fired. Re-read and return the
    // now-existing user. Any OTHER error propagates (fail-closed, #3).
    if (err instanceof UsuarioEmailJaExisteError) {
      const existente = await deps.usuarioRepository.findUsuarioById(idUsuario as IdUsuario);
      if (existente) return existente;
    }
    throw err;
  }
}

/**
 * THE fused A2 + heal resolver — the single entrypoint every authed router
 * uses. Resolves the session (A2), then guarantees the domain `usuarios` row
 * exists: found → return it; missing → self-heal (OAuth orphan) or fail-closed.
 *
 * Throws `SessaoNaoAutenticadaError` when no session resolves OR the heal fails.
 * Returns the resolved `usuario` + the session `expiraEm`.
 */
export async function resolverUsuarioAutenticado(
  deps: ServerDeps,
  headers: Headers,
): Promise<{ usuario: Usuario; expiraEm: Date }> {
  const sessao = await resolverSessao(deps, headers);
  if (!sessao) throw new SessaoNaoAutenticadaError('sem_sessao');

  const existente = await deps.usuarioRepository.findUsuarioById(
    sessao.idUsuario as IdUsuario,
  );
  if (existente) return { usuario: existente, expiraEm: sessao.expiraEm };

  // Orphan. Heal requires the provisioning principal — present only on the
  // getSession/OAuth path. A bare-cookie session whose usuarios row is gone is
  // an unprovisionable inconsistency → fail-closed.
  if (!sessao.principal) {
    deps.observability.logger.info('usuario.sessao.orfao_sem_principal', {
      idUsuario: sessao.idUsuario,
    });
    throw new SessaoNaoAutenticadaError('orfao_heal_falhou');
  }

  let usuario: Usuario;
  try {
    usuario = await autoProvisionarUsuarioOrfao(deps, sessao.idUsuario, sessao.principal);
  } catch (err) {
    deps.observability.logger.info('usuario.sessao.auto_provisionamento_falhou', {
      idUsuario: sessao.idUsuario,
      idPlataforma: sessao.principal.idPlataforma,
      erro: err instanceof Error ? err.message : String(err),
    });
    throw new SessaoNaoAutenticadaError('orfao_heal_falhou');
  }
  return { usuario, expiraEm: sessao.expiraEm };
}

/**
 * Null-returning sibling of `resolverUsuarioAutenticado` for the `auth.me`
 * probe (which returns null rather than throwing on no-session). Same fused
 * A2 + heal core — collapses the `SessaoNaoAutenticadaError` to null and lets
 * any other (unexpected) error propagate.
 */
export async function resolverUsuarioAutenticadoOuNull(
  deps: ServerDeps,
  headers: Headers,
): Promise<{ usuario: Usuario; expiraEm: Date } | null> {
  try {
    return await resolverUsuarioAutenticado(deps, headers);
  } catch (err) {
    if (err instanceof SessaoNaoAutenticadaError) return null;
    throw err;
  }
}
