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
