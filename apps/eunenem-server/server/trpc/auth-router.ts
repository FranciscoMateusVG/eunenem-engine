import { randomUUID } from 'node:crypto';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  criarSessaoUsuario,
  hashClientPII,
  registrarContaUsuario,
  UsuarioEmailJaExisteError,
  UsuarioInputInvalidoError,
  UsuarioPlataformaNaoEncontradaError,
  UsuarioSessaoInvalidaError,
} from '../../../../src/index.js';
import { trustedClientIp } from '../lib/security/trusted-client-ip.js';
import type { TrpcContext } from './context.js';
import { enforceRateLimit } from './rate-limit.js';

/**
 * Rate-limit posture (aperture-uc2ix) — matches Cipher's recommendation:
 *   signIn: 10 attempts per 60s per (ip, email)
 *   signUp:  3 attempts per 60s per ip
 * Buckets are DB-backed (rate_limit table from migration 009; multi-instance
 * safe, survives container restart). Per-(ip,email) on signIn means a botnet
 * spreading across distributed IPs hits the per-email cap even if no
 * individual IP exceeds the limit; per-ip on signUp protects against a
 * single attacker mass-registering accounts.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_SIGN_IN_MAX = 10;
const RATE_LIMIT_SIGN_UP_MAX = 3;

/**
 * Structured emission shape (aperture-3pqt7 / T9). Fired BEFORE
 * rate-limit rejection so rate-limited attempts are still observable —
 * without that ordering you can't detect a credential-stuffing burst
 * just by reading logs (it would silently 429 with no audit trail).
 */
type SignInEmissionStatus =
  | 'success'
  | 'failed'
  | 'rate_limited'
  | 'inconsistencia_dominio'
  | 'error';

function emitSignInAttempt(
  ctx: TrpcContext,
  fields: {
    readonly idPlataforma: string;
    readonly emailHash: string;
    readonly ipHashed: string;
    readonly status: SignInEmissionStatus;
  },
): void {
  ctx.deps.observability.logger.info('usuario.sessao.tentativa', {
    idPlataforma: fields.idPlataforma,
    emailHash: fields.emailHash,
    ipHashed: fields.ipHashed,
    timestampIso: new Date().toISOString(),
    status: fields.status,
  });
}

type SignUpEmissionStatus = 'success' | 'failed' | 'rate_limited' | 'error';

function emitSignUpAttempt(
  ctx: TrpcContext,
  fields: {
    readonly idPlataforma: string;
    readonly emailHash: string;
    readonly ipHashed: string;
    readonly status: SignUpEmissionStatus;
  },
): void {
  ctx.deps.observability.logger.info('usuario.conta.registro_tentativa', {
    idPlataforma: fields.idPlataforma,
    emailHash: fields.emailHash,
    ipHashed: fields.ipHashed,
    timestampIso: new Date().toISOString(),
    status: fields.status,
  });
}

/**
 * Emission status taxonomy for the unified login-or-signup mutation
 * (aperture-d7993). The login-vs-signup distinction is DESIRED and
 * internal — it is invisible to the caller (both wrong-password and the
 * not-yet-created cases that fail surface the SAME ambiguous error), but
 * the structured log records which branch ran so operators can detect
 * credential-stuffing vs mass-registration patterns separately.
 *
 *   login_success  — existing user, correct password, session issued.
 *   login_failed   — existing user, wrong password (same error signIn throws).
 *   signup_success — no existing user, account created + session issued.
 *   rate_limited   — either the login-grade or the signup-grade cap tripped.
 *   error          — any unexpected failure.
 */
type ContinueWithEmailEmissionStatus =
  | 'login_success'
  | 'login_failed'
  | 'signup_success'
  // Internal-only (aperture-oss3g): a create-branch BetterAuth users-table
  // UNIQUE collision (email has a BetterAuth row but no `usuarios` domain
  // row). Surfaced to the caller as the SAME ambiguous bad-credentials error
  // — this status exists purely so the data-integrity orphan is queryable in
  // the logs; it never reaches the client.
  | 'signup_collision'
  | 'rate_limited'
  | 'error';

/**
 * Structured emission for `continuarComEmail` (aperture-d7993). Mirrors
 * `emitSignInAttempt`'s field-shaping exactly — same hashed-PII fields,
 * same timestamp shape — under a distinct event name so the unified flow
 * is queryable on its own. Fired in EVERY exit branch and BEFORE any
 * rate-limit re-throw (same ordering discipline as signIn/signUp).
 */
function emitContinueWithEmailAttempt(
  ctx: TrpcContext,
  fields: {
    readonly idPlataforma: string;
    readonly emailHash: string;
    readonly ipHashed: string;
    readonly status: ContinueWithEmailEmissionStatus;
  },
): void {
  ctx.deps.observability.logger.info('usuario.continue_with_email.tentativa', {
    idPlataforma: fields.idPlataforma,
    emailHash: fields.emailHash,
    ipHashed: fields.ipHashed,
    timestampIso: new Date().toISOString(),
    status: fields.status,
  });
}

const t = initTRPC.context<TrpcContext>().create();

const SignUpInputSchema = z.object({
  email: z.email(),
  senha: z.string().min(8, 'Senha precisa de pelo menos 8 caracteres').max(200),
  nomeExibicao: z.string().min(1).max(120),
  idPlataforma: z.uuid(),
});

const SignInInputSchema = z.object({
  email: z.email(),
  senha: z.string().min(1).max(200),
  idPlataforma: z.uuid(),
});

/**
 * Unified login-or-signup input (aperture-d7993, Option B). email + senha
 * + idPlataforma match `SignInInputSchema` (senha `min(1)` — NOT `min(8)`
 * — so an existing account with any legacy password can still log in; the
 * login path is the dominant constraint for a unified flow). `nomeExibicao`
 * is optional: only the create branch consumes it, and when absent we
 * derive a default the same way the engine would (see the procedure body).
 */
const ContinuarComEmailInputSchema = z.object({
  email: z.email(),
  senha: z.string().min(8, 'Senha precisa de pelo menos 8 caracteres').max(200),
  idPlataforma: z.uuid(),
  nomeExibicao: z.string().min(1).max(120).optional(),
});

/**
 * Read the session token from the Cookie header. Hono normalizes cookies
 * via getCookie() but the tRPC context only has the raw Headers object,
 * so we parse it ourselves — same logic as Hono's getCookie helper,
 * just inlined.
 */
function readSessionCookie(headers: Headers, name: string): string | null {
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
 * Append a Set-Cookie header that pins the session token (aperture-ht7sq).
 * Cookie attributes match BetterAuth's default cookie posture: HttpOnly,
 * SameSite=Lax, Path=/. `Secure` flag follows `useSecureCookies` from
 * setup (T8 — env-driven).
 *
 * `maxAgeSeconds` is computed from `expiraEm` so the cookie outlives the
 * session by exactly the session's own TTL — browsers stop sending the
 * cookie at exactly the same time the engine's `validarSessao` would
 * start returning null.
 */
function setSessionCookie(
  resHeaders: Headers,
  name: string,
  token: string,
  expiraEm: Date,
  useSecureCookies: boolean,
): void {
  const maxAge = Math.max(0, Math.floor((expiraEm.getTime() - Date.now()) / 1000));
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAge}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (useSecureCookies) parts.push('Secure');
  resHeaders.append('set-cookie', parts.join('; '));
}

/** Set-Cookie that clears the session cookie immediately (for signOut). */
function clearSessionCookie(
  resHeaders: Headers,
  name: string,
  useSecureCookies: boolean,
): void {
  const parts = [`${name}=`, `Max-Age=0`, `Path=/`, `HttpOnly`, `SameSite=Lax`];
  if (useSecureCookies) parts.push('Secure');
  resHeaders.append('set-cookie', parts.join('; '));
}

/**
 * Map engine errors to tRPC errors (aperture-ht7sq). Preserves the typed
 * error codes from the engine so the client can route the right per-field
 * message (Vance's AuthError discriminated union expects these codes).
 */
function toTRPCError(err: unknown): TRPCError {
  if (err instanceof UsuarioEmailJaExisteError) {
    return new TRPCError({
      code: 'CONFLICT',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof UsuarioPlataformaNaoEncontradaError) {
    return new TRPCError({
      code: 'NOT_FOUND',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof UsuarioSessaoInvalidaError) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof UsuarioInputInvalidoError) {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: err.message,
      cause: err,
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

/**
 * Auth router (aperture-ht7sq) — Mount-Option-A2 from recon §5 Pattern A.
 *
 * Every credential-touching procedure wraps the engine's use-case so
 * domain rules (plataforma validation, composite email uniqueness,
 * compensation discipline) ALWAYS run. We never call `auth.api.signUp`
 * directly — the engine's saga is the source of truth for
 * registration, and BetterAuth's HTTP runtime at /api/auth/* is for
 * complementary flows (password reset, email verification) that the
 * engine doesn't own yet.
 *
 * Cookie management: this router sets and clears the
 * `better-auth.session_token` cookie itself. We use BetterAuth's
 * conventional cookie name so the auth.handler mount at /api/auth/*
 * recognises sessions created via tRPC (and vice versa).
 */
export const authRouter = t.router({
  signUp: t.procedure
    .input(SignUpInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { deps, headers, resHeaders } = ctx;
      const idUsuario = randomUUID();
      const idConta = randomUUID();

      // aperture-3pqt7: capture + hash trusted client IP BEFORE any
      // side-effect-bearing call. emailHash + ipHashed are derived once
      // and reused across the rate-limit + emission paths so the
      // structured log carries the same identifier regardless of which
      // exit branch fires.
      const rawIp = trustedClientIp(headers, deps.trustedHopCount);
      const ipHashed = hashClientPII(rawIp, deps.logPiiHashSalt);
      const emailHash = hashClientPII(input.email, deps.logPiiHashSalt);

      // aperture-uc2ix: rate-limit signUp per IP only — no email key
      // (the attacker WANTS to register new emails; per-email throttle
      // would be vacuous). 3 per 60s per IP per Cipher's recommended
      // posture.
      try {
        await enforceRateLimit(deps.db, {
          key: `trpc:signUp:${ipHashed}`,
          max: RATE_LIMIT_SIGN_UP_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
          clock: deps.clock,
        });
      } catch (err) {
        // Emit BEFORE re-throw (GLaDOS ordering — don't lose visibility
        // into rate-limited attempts; otherwise an attacker pacing just
        // over the cap leaves no audit trail).
        emitSignUpAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'rate_limited',
        });
        throw err;
      }

      try {
        // Mount-Option-A2: registrarContaUsuario carries the T3 saga
        // (engine domain rules + auth.criarConta + Campanha + 'presente'
        // opcao + compensation cascade). After p8i01 the saga also returns
        // the default Campanha — every signed-up user owns exactly one
        // "Lista de <nome>" with one initial OpcaoContribuicao.
        await registrarContaUsuario(
          {
            usuarioRepository: deps.usuarioRepository,
            plataformaRepository: deps.plataformaRepository,
            campanhaRepository: deps.campanhaRepository,
            recebedorRepository: deps.recebedorRepository,
            authService: deps.authService,
            clock: deps.clock,
            observability: deps.observability,
          },
          {
            idUsuario,
            idConta,
            idPlataforma: input.idPlataforma,
            email: input.email,
            nomeExibicao: input.nomeExibicao,
            senhaSimulada: input.senha,
          },
        );

        // Immediately sign in so the response carries a session cookie —
        // matches BetterAuth's HTTP signup flow (account created +
        // logged in in one request). Caller doesn't have to follow up
        // with a separate signIn call. Pass ipHashed so the new session
        // row gets the hashed IP for forensic correlation.
        const sessao = await deps.authService.iniciarSessao({
          idPlataforma: input.idPlataforma,
          email: input.email,
          senha: input.senha,
          ipHashed,
        });

        setSessionCookie(
          resHeaders,
          deps.sessionCookieName,
          sessao.token,
          sessao.expiraEm,
          deps.auth.options.advanced?.useSecureCookies ?? false,
        );

        emitSignUpAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'success',
        });

        return {
          idUsuario,
          idConta,
          expiraEm: sessao.expiraEm,
        };
      } catch (err) {
        emitSignUpAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: err instanceof UsuarioInputInvalidoError ? 'failed' : 'error',
        });
        throw toTRPCError(err);
      }
    }),

  signIn: t.procedure
    .input(SignInInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { deps, headers, resHeaders } = ctx;

      // aperture-3pqt7: capture + hash BEFORE any decision (see signUp
      // comments for rationale). Same shape, different bucket strategy
      // for the rate-limit key.
      const rawIp = trustedClientIp(headers, deps.trustedHopCount);
      const ipHashed = hashClientPII(rawIp, deps.logPiiHashSalt);
      const emailHash = hashClientPII(input.email, deps.logPiiHashSalt);

      // aperture-uc2ix: rate-limit signIn per (ip, email) — catches both
      // single-IP brute-force AND distributed credential stuffing (a
      // botnet hitting the same email from 1000 IPs still trips the
      // per-email cap). 10 per 60s per (ip, email) per Cipher's posture.
      try {
        await enforceRateLimit(deps.db, {
          key: `trpc:signIn:${ipHashed}:${emailHash}`,
          max: RATE_LIMIT_SIGN_IN_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
          clock: deps.clock,
        });
      } catch (err) {
        emitSignInAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'rate_limited',
        });
        throw err;
      }

      try {
        const sessao = await criarSessaoUsuario(
          {
            usuarioRepository: deps.usuarioRepository,
            authService: deps.authService,
            observability: deps.observability,
          },
          {
            idPlataforma: input.idPlataforma,
            email: input.email,
            senhaSimulada: input.senha,
            ipHashed,
          },
        );

        setSessionCookie(
          resHeaders,
          deps.sessionCookieName,
          sessao.token,
          sessao.expiraEm,
          deps.auth.options.advanced?.useSecureCookies ?? false,
        );

        emitSignInAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'success',
        });

        return {
          idUsuario: sessao.idUsuario,
          idConta: sessao.idConta,
          expiraEm: sessao.expiraEm,
        };
      } catch (err) {
        // Map error to status taxonomy. The defensive auth+domain drift
        // path throws a plain Error with a known marker substring (see
        // criar-sessao-usuario.ts header).
        const status: SignInEmissionStatus =
          err instanceof UsuarioInputInvalidoError
            ? 'failed'
            : err instanceof Error && err.message.includes('inconsistencia auth+dominio')
              ? 'inconsistencia_dominio'
              : 'error';
        emitSignInAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status,
        });
        throw toTRPCError(err);
      }
    }),

  /**
   * Unified login-or-signup (aperture-d7993, Option B — Cipher-locked).
   *
   * Single entry point for the "continue with email" UX: the caller does
   * not pre-know whether the email is registered. We decide server-side
   * and either log the existing user in OR create the account and log
   * them in, returning the SAME session shape in both cases.
   *
   * SECURITY ORDER (locked — do not reorder):
   *   1. Login-grade rate limit FIRST, BEFORE any DB lookup. Shares the
   *      EXACT bucket key the existing `signIn` uses
   *      (`trpc:signIn:<ipHash>:<emailHash>`), so an attacker cannot
   *      bypass signIn's per-(ip,email) cap by funnelling guesses through
   *      this endpoint — the buckets are the same row.
   *   2. `findUsuarioByEmail` (tenant-scoped).
   *   3a. EXISTS → login path (one scrypt via `criarSessaoUsuario`).
   *       Wrong password throws the SAME ambiguous error `signIn` throws —
   *       we do NOT invent a distinct "no account" error (that would be a
   *       user-enumeration oracle on the unified flow).
   *   3b. NOT-EXISTS → creation. Check the signup-grade rate limit NOW
   *       (per-ip, sharing `signUp`'s `trpc:signUp:<ipHash>` bucket — same
   *       anti-bypass reasoning), then `registrarContaUsuario` (which sets
   *       `email_verified = false` in the BetterAuth adapter's
   *       `criarConta` — forward-compat for future email verification) +
   *       sign in (one scrypt — the hashPassword inside criarConta).
   *
   * The login-vs-signup distinction is recorded in the emission (internal)
   * AND surfaced to the caller via the `criado` flag (false = logged into an
   * existing account, true = a new account was created). This is a deliberate
   * reversal of the original "never leaks to the caller" posture, approved by
   * Cipher (aperture-d7993): the outcome-residual is already attacker-derivable
   * in a single real attempt (a create branch always creates an account + emits
   * signup_success; a login requires the correct password) and is bounded by
   * the shared login/signup rate-limit buckets, so a machine-readable flag on
   * the SUCCESS path adds zero bits an attacker did not already hold. The flag
   * is never returned on the failure path (wrong password / rate-limited throw
   * the same ambiguous error before any return). The frontend uses it to branch
   * post-success UX: login -> /painel, create -> onboarding wizard.
   */
  continuarComEmail: t.procedure
    .input(ContinuarComEmailInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { deps, headers, resHeaders } = ctx;

      // Capture + hash client PII once, reused across rate-limit + emission
      // (same discipline as signIn/signUp).
      const rawIp = trustedClientIp(headers, deps.trustedHopCount);
      const ipHashed = hashClientPII(rawIp, deps.logPiiHashSalt);
      const emailHash = hashClientPII(input.email, deps.logPiiHashSalt);

      // STEP 1 — login-grade rate limit FIRST, before any DB lookup.
      // SAME key + helper as signIn (anti-bypass: shared bucket row).
      try {
        await enforceRateLimit(deps.db, {
          key: `trpc:signIn:${ipHashed}:${emailHash}`,
          max: RATE_LIMIT_SIGN_IN_MAX,
          windowMs: RATE_LIMIT_WINDOW_MS,
          clock: deps.clock,
        });
      } catch (err) {
        emitContinueWithEmailAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'rate_limited',
        });
        // Re-throw the SAME TOO_MANY_REQUESTS error signIn throws.
        throw err;
      }

      try {
        // STEP 2 — tenant-scoped lookup.
        const existing = await deps.usuarioRepository.findUsuarioByEmail(
          input.idPlataforma,
          input.email,
        );

        if (existing) {
          // STEP 3a — LOGIN path. One scrypt inside criarSessaoUsuario →
          // iniciarSessao. Wrong password surfaces the SAME ambiguous
          // UsuarioInputInvalidoError signIn throws.
          try {
            const sessao = await criarSessaoUsuario(
              {
                usuarioRepository: deps.usuarioRepository,
                authService: deps.authService,
                observability: deps.observability,
              },
              {
                idPlataforma: input.idPlataforma,
                email: input.email,
                senhaSimulada: input.senha,
                ipHashed,
              },
            );

            setSessionCookie(
              resHeaders,
              deps.sessionCookieName,
              sessao.token,
              sessao.expiraEm,
              deps.auth.options.advanced?.useSecureCookies ?? false,
            );

            emitContinueWithEmailAttempt(ctx, {
              idPlataforma: input.idPlataforma,
              emailHash,
              ipHashed,
              status: 'login_success',
            });

            return {
              idUsuario: sessao.idUsuario,
              idConta: sessao.idConta,
              expiraEm: sessao.expiraEm,
              criado: false as const,
            };
          } catch (err) {
            // Wrong-password (the ambiguous bad-credentials error) is a
            // login_failed; anything else is an unexpected error. Either
            // way the caller sees the same error signIn would surface — we
            // do NOT swap in a distinct "no account" message.
            if (err instanceof UsuarioInputInvalidoError) {
              emitContinueWithEmailAttempt(ctx, {
                idPlataforma: input.idPlataforma,
                emailHash,
                ipHashed,
                status: 'login_failed',
              });
            } else {
              emitContinueWithEmailAttempt(ctx, {
                idPlataforma: input.idPlataforma,
                emailHash,
                ipHashed,
                status: 'error',
              });
            }
            throw toTRPCError(err);
          }
        }

        // STEP 3b — CREATION path. Check the signup-grade rate limit NOW,
        // and ONLY on this branch. SAME key + helper as signUp (anti-bypass).
        try {
          await enforceRateLimit(deps.db, {
            key: `trpc:signUp:${ipHashed}`,
            max: RATE_LIMIT_SIGN_UP_MAX,
            windowMs: RATE_LIMIT_WINDOW_MS,
            clock: deps.clock,
          });
        } catch (err) {
          emitContinueWithEmailAttempt(ctx, {
            idPlataforma: input.idPlataforma,
            emailHash,
            ipHashed,
            status: 'rate_limited',
          });
          // Re-throw the SAME TOO_MANY_REQUESTS error signUp throws.
          throw err;
        }

        // Derive a display name when the caller didn't supply one. Mirrors
        // signUp's contract (it requires nomeExibicao) by falling back to
        // the email local-part — a sensible, non-empty default that the
        // NomeExibicaoUsuario value object accepts (trimmed, 1..120 chars).
        const nomeExibicao =
          input.nomeExibicao?.trim() || input.email.split('@')[0] || input.email;

        const idUsuario = randomUUID();
        const idConta = randomUUID();

        try {
          await registrarContaUsuario(
            {
              usuarioRepository: deps.usuarioRepository,
              plataformaRepository: deps.plataformaRepository,
              campanhaRepository: deps.campanhaRepository,
              recebedorRepository: deps.recebedorRepository,
              authService: deps.authService,
              clock: deps.clock,
              observability: deps.observability,
            },
            {
              idUsuario,
              idConta,
              idPlataforma: input.idPlataforma,
              email: input.email,
              nomeExibicao,
              senhaSimulada: input.senha,
            },
          );
        } catch (err) {
          // aperture-oss3g — enumeration-oracle close. STEP 2's
          // findUsuarioByEmail only checks the DOMAIN `usuarios` table; if no
          // domain row exists we land here in the create branch. But the
          // BetterAuth `users` table has its own UNIQUE(id_plataforma,email):
          // an email that has a BetterAuth row WITHOUT a matching `usuarios`
          // row (today only a saga-orphan; systematic the moment any
          // social/OAuth provider is wired and OAuth users get a BetterAuth
          // row without a domain row) makes criarConta's INSERT throw
          // UsuarioEmailJaExisteError. The default toTRPCError maps that to
          // CONFLICT — a status/body DISTINGUISHABLE from the ambiguous
          // BAD_REQUEST wrong-password returns, i.e. an email-existence oracle
          // that doesn't even create an account. Collapse the collision into
          // the SAME ambiguous 'Email ou senha invalidos' so it is
          // indistinguishable from a failed login. Emit a distinct INTERNAL
          // status (never reaches the caller) so the data-integrity orphan
          // stays queryable. Throwing a TRPCError here means the outer catch
          // passes it through without re-emitting (mirrors the login branch).
          if (err instanceof UsuarioEmailJaExisteError) {
            emitContinueWithEmailAttempt(ctx, {
              idPlataforma: input.idPlataforma,
              emailHash,
              ipHashed,
              status: 'signup_collision',
            });
            throw toTRPCError(
              new UsuarioInputInvalidoError('Email ou senha invalidos'),
            );
          }
          throw err;
        }

        // Immediately sign in (same as signUp) — one scrypt was already
        // paid by criarConta's hashPassword; this verify pays a second,
        // but that only affects the create branch (which already cost a
        // hashPassword), not the security-sensitive login/unknown timing.
        const sessao = await deps.authService.iniciarSessao({
          idPlataforma: input.idPlataforma,
          email: input.email,
          senha: input.senha,
          ipHashed,
        });

        setSessionCookie(
          resHeaders,
          deps.sessionCookieName,
          sessao.token,
          sessao.expiraEm,
          deps.auth.options.advanced?.useSecureCookies ?? false,
        );

        emitContinueWithEmailAttempt(ctx, {
          idPlataforma: input.idPlataforma,
          emailHash,
          ipHashed,
          status: 'signup_success',
        });

        return {
          idUsuario,
          idConta,
          expiraEm: sessao.expiraEm,
          criado: true as const,
        };
      } catch (err) {
        // Any UNEXPECTED error that escaped the inner branch handlers
        // (e.g. a registrarContaUsuario failure on the create path) lands
        // here. The login-branch handler already emitted + re-threw a
        // TRPCError, so re-emitting on a TRPCError would double-count;
        // only emit 'error' for raw (engine) errors that reach this far.
        if (!(err instanceof TRPCError)) {
          emitContinueWithEmailAttempt(ctx, {
            idPlataforma: input.idPlataforma,
            emailHash,
            ipHashed,
            status: 'error',
          });
          throw toTRPCError(err);
        }
        throw err;
      }
    }),

  signOut: t.procedure.mutation(async ({ ctx }) => {
    const { deps, headers, resHeaders } = ctx;
    const token = readSessionCookie(headers, deps.sessionCookieName);
    if (token) {
      // Validate-then-strip on the way out — TokenSessaoSchema requires
      // ≥32 chars, so a garbage cookie value would throw. Silently
      // ignore that: signing out should never error on a malformed
      // cookie.
      try {
        await deps.authService.revogarSessao(token);
      } catch {
        // ignore — cookie is being cleared anyway
      }
    }
    clearSessionCookie(
      resHeaders,
      deps.sessionCookieName,
      deps.auth.options.advanced?.useSecureCookies ?? false,
    );
    return { ok: true as const };
  }),

  /**
   * Probe: returns the currently-authenticated user's id + session expiry
   * if the cookie maps to a live session, or `null` otherwise.
   * Frontend's "am I logged in?" check.
   *
   * Post-aperture-p8i01: also returns `idCampanha` + `idOpcaoPresentes`
   * so the frontend can render the user's Lista de presentes without a
   * follow-up round-trip. The signup saga guarantees both exist for
   * every signed-up user. For backfilled users (pre-p8i01) the values
   * resolve via `campanhaRepository.findFirstByAdministrador`; if the
   * backfill hasn't run yet (or somehow missed a user) both fields are
   * `null` and the client falls back to an empty-list UX.
   */
  me: t.procedure.query(async ({ ctx }) => {
    const { deps, headers } = ctx;
    const token = readSessionCookie(headers, deps.sessionCookieName);
    if (!token) return null;
    let sessao;
    try {
      sessao = await deps.authService.validarSessao(token);
    } catch {
      // Malformed token (fails TokenSessaoSchema.parse) — treat as no session.
      return null;
    }
    if (!sessao) return null;
    const usuario = await deps.usuarioRepository.findUsuarioById(sessao.idUsuario);
    if (!usuario) return null;

    // p8i01: resolve the user's default Campanha + the 'presente' opcao
    // inside it. Single DB hit (findFirstByAdministrador joins
    // campanhas + campanha_administradores + opcoes_contribuicao).
    const campanha = await deps.campanhaRepository.findFirstByAdministrador(usuario.idConta);
    const opcaoPresentes = campanha?.opcoes.find((o) => o.tipo === 'presente');

    return {
      idUsuario: usuario.id,
      idConta: usuario.idConta,
      idPlataforma: usuario.idPlataforma,
      email: usuario.email,
      nomeExibicao: usuario.nomeExibicao,
      /**
       * Public URL slug (aperture-khbow). Lets the client redirect to
       * `/painel/<slug>` post-auth in one round-trip — no follow-up call
       * to fetch the user's own slug.
       */
      slug: usuario.slug,
      /**
       * Default Campanha id (aperture-p8i01). null only if backfill
       * has not yet been applied to a pre-p8i01 user.
       */
      idCampanha: campanha?.id ?? null,
      /**
       * Initial 'presente' OpcaoContribuicao id inside the default
       * Campanha (aperture-p8i01). Same caveat as idCampanha.
       */
      idOpcaoPresentes: opcaoPresentes?.id ?? null,
      /**
       * aperture-0bynm — Solicitar Transferência onboarding embed.
       * `true` when the user's default campanha has an active recebedor
       * linked; `false` otherwise (first-time onboarding required).
       * Derived from the campanha aggregate's `idRecebedor` field
       * (Plan 0015 invariant — `idRecebedor` and `dadosRecebedor` are
       * either BOTH null or BOTH set). NO extra DB call.
       *
       * Frontend's TransferModal reads this to decide whether to embed
       * the BancariosBody onboarding form or proceed straight to
       * solicitarRepasse. `false` when `idCampanha` is null (the
       * pre-p8i01 backfill caveat) — frontend treats both the
       * no-campanha and no-recebedor cases as "render the form".
       */
      hasRecebedor: campanha?.idRecebedor != null,
      expiraEm: sessao.expiraEm,
    };
  }),
});

export type AuthRouter = typeof authRouter;
