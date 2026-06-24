// aperture-d0x1w — real auth client.
//
// Swaps the mock at `lib/mocks/auth.ts` for the real tRPC procedures Rex
// shipped in PR #61 (aperture-ht7sq). Same import surface for the modal
// shell (`auth.signUp` / `auth.signIn` / `auth.signOut` / `useMe`); the
// shapes underneath are now PT-BR + idPlataforma-scoped.
//
// Contract Rex shipped:
//   auth.signUp({ email, senha, nomeExibicao, idPlataforma }) ->
//     { idUsuario, idConta, expiraEm } + Set-Cookie better-auth.session_token
//   auth.signIn({ email, senha, idPlataforma }) ->
//     { idUsuario, idConta, expiraEm } + Set-Cookie
//   auth.signOut() -> { ok: true } + Set-Cookie (cleared)
//   auth.me() -> { idUsuario, idConta, idPlataforma, email, nomeExibicao, slug, expiraEm } | null
//                                                                          ^^^^ aperture-khbow
//
// Errors are mapped server-side to tRPC codes; the mapping is
// OPERATION-AWARE because BAD_REQUEST is overloaded:
//
//   signUp:
//     CONFLICT     → email-taken                 (UsuarioEmailJaExisteError)
//     BAD_REQUEST  → short-password (min 8)      (UsuarioInputInvalidoError — zod or engine)
//     NOT_FOUND    → network                     (plataforma not seeded; shouldn't fire)
//     UNAUTHORIZED → credentials                 (shouldn't fire on signUp; defensive)
//
//   signIn:
//     UNAUTHORIZED → credentials                 (UsuarioSessaoInvalidaError)
//     BAD_REQUEST  → credentials                 (UsuarioInputInvalidoError — engine raises
//                                                this for "Email ou senha invalidos"; the
//                                                client-side modal pre-validates length, so
//                                                a BAD_REQUEST that reaches the server is
//                                                almost certainly wrong creds)
//     NOT_FOUND    → network                     (plataforma not seeded; shouldn't fire)
//     CONFLICT     → network                     (shouldn't fire on signIn; defensive)
//
//   anything else → network
//
// The UI keeps the same `AuthError` discriminated union it already routes
// on, so per-field error rendering is unchanged.

import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";

import { trpc } from "./trpc.js";
import { ID_PLATAFORMA_EUNENEM } from "./constants.js";

// ── Public types ────────────────────────────────────────────────────────────

/** Currently-authenticated user as returned by `auth.me`. */
export interface AuthUser {
  idUsuario: string;
  idConta: string;
  idPlataforma: string;
  email: string;
  nomeExibicao: string;
  /**
   * Public URL slug (aperture-khbow). Use to redirect post-auth to
   * `/painel/<slug>` without a follow-up request.
   */
  slug: string;
}

/** Result of a successful signUp / signIn / continuarComEmail. */
export interface AuthSession {
  user: { email: string; nomeExibicao: string };
  /** ISO timestamp string for cross-tree serialisation. */
  expiraEm: string;
  /**
   * aperture-d7993 — true when the auth call CREATED a new account
   * (→ caller shows the onboarding wizard), false when it logged into an
   * existing one (→ caller redirects straight to the painel). `signUp`
   * always reports true; `signIn` always false; `continuarComEmail` reports
   * the server's branch decision.
   */
  criado: boolean;
}

/** Discriminated error type so the UI can render the right field message. */
export type AuthError =
  | { kind: "invalid-email" }
  | { kind: "short-password"; minLength: number }
  | { kind: "credentials" }
  | { kind: "email-taken" }
  | { kind: "rate-limited" }
  | { kind: "network" };

/** Engine zod enforces ≥8 — keep in lock-step with `SignUpInputSchema`. */
export const MIN_PASSWORD_LENGTH = 8;

export function authErrorMessage(err: AuthError): string {
  switch (err.kind) {
    case "invalid-email":
      return "esse e-mail tá meio torto — confere pra mim?";
    case "short-password":
      return `a senha precisa ter pelo menos ${err.minLength} caracteres ♡`;
    case "credentials":
      return "e-mail ou senha não bateram — tenta de novo?";
    case "email-taken":
      return "esse e-mail já tem conta — bora entrar?";
    case "rate-limited":
      return "muitas tentativas — espera um pouquinho e tenta de novo ♡";
    case "network":
      return "deu ruim na conexão — tenta de novo daqui a pouco ♡";
  }
}

/** RFC5322-lite — matches `local@domain.tld` shapes the user actually types. */
export function isValidEmail(email: string): boolean {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── Error mapping ───────────────────────────────────────────────────────────

export type AuthOperation = "signUp" | "signIn" | "continuarComEmail";

/**
 * Translate a thrown tRPC error into the modal's `AuthError` shape. The
 * mapping depends on which procedure failed — see the file header for the
 * full table. Anything we can't recognise (network blip, unexpected server
 * crash) collapses to `network` so the user sees a friendly retry message
 * instead of a stack trace.
 */
export function toAuthError(err: unknown, op: AuthOperation): AuthError {
  if (err instanceof TRPCClientError) {
    const code = err.data?.code;
    if (op === "signUp") {
      switch (code) {
        case "CONFLICT":
          return { kind: "email-taken" };
        case "BAD_REQUEST":
          return { kind: "short-password", minLength: MIN_PASSWORD_LENGTH };
        case "UNAUTHORIZED":
          return { kind: "credentials" };
        default:
          return { kind: "network" };
      }
    }
    if (op === "continuarComEmail") {
      // aperture-d7993 — the unified login-or-create submit. The server keeps
      // the wrong-password / no-account outcome AMBIGUOUS (UsuarioInputInvalido
      // → credentials), so we never surface a distinct "no account" message.
      // Rate-limit rejections surface their own friendly message.
      switch (code) {
        case "UNAUTHORIZED":
        case "BAD_REQUEST":
          return { kind: "credentials" };
        case "TOO_MANY_REQUESTS":
          return { kind: "rate-limited" };
        default:
          return { kind: "network" };
      }
    }
    // signIn
    switch (code) {
      case "UNAUTHORIZED":
      case "BAD_REQUEST":
        return { kind: "credentials" };
      case "TOO_MANY_REQUESTS":
        return { kind: "rate-limited" };
      default:
        return { kind: "network" };
    }
  }
  return { kind: "network" };
}

// ── React hooks (component API) ─────────────────────────────────────────────

/**
 * Sign up + sign in in one round-trip. The server-side procedure does the
 * full saga (registrarContaUsuario + iniciarSessao) and sets the
 * `better-auth.session_token` cookie before responding, so the client only
 * has to invalidate the `me` query and the rest of the app rerenders as
 * authenticated.
 */
export function useSignUp() {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.signUp.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
    },
  });

  const signUp = useCallback(
    async (input: { email: string; password: string; name: string }): Promise<AuthSession> => {
      try {
        const result = await mutation.mutateAsync({
          email: input.email.trim(),
          senha: input.password,
          nomeExibicao: input.name.trim(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
        });
        return {
          user: { email: input.email.trim(), nomeExibicao: input.name.trim() },
          expiraEm: serializeDate(result.expiraEm),
          criado: true,
        };
      } catch (err) {
        throw toAuthError(err, "signUp");
      }
    },
    [mutation],
  );

  return { signUp, isPending: mutation.isPending };
}

export function useSignIn() {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.signIn.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
    },
  });

  const signIn = useCallback(
    async (input: { email: string; password: string }): Promise<AuthSession> => {
      try {
        const result = await mutation.mutateAsync({
          email: input.email.trim(),
          senha: input.password,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
        });
        return {
          user: { email: input.email.trim(), nomeExibicao: input.email.trim() },
          expiraEm: serializeDate(result.expiraEm),
          criado: false,
        };
      } catch (err) {
        throw toAuthError(err, "signIn");
      }
    },
    [mutation],
  );

  return { signIn, isPending: mutation.isPending };
}

/**
 * aperture-d7993 — email-first unified entry (Option B). One submit decides
 * login-vs-create SERVER-SIDE (Rex's `auth.continuarComEmail`, PR #271): the
 * client never asks "does this email exist?" (zero existence endpoint — no
 * enumeration oracle). The server branches on a tenant-scoped lookup, pays
 * exactly one scrypt either way, and returns a session cookie. The result's
 * `criado` flag (Rex #273) tells the caller whether a NEW account was created
 * (→ show onboarding) or an existing one logged in (→ redirect to painel).
 *
 * `criado` is read via a cast so this typechecks against the current staging
 * type whether or not #273 (the flag) is in the base yet — this PR must merge
 * AFTER #273 so the flag is real at runtime. Wrong password surfaces the same
 * ambiguous `credentials` error as signIn; rate-limit → `rate-limited`.
 */
export function useContinuarComEmail() {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.continuarComEmail.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
    },
  });

  const continuarComEmail = useCallback(
    async (input: { email: string; password: string }): Promise<AuthSession> => {
      try {
        const result = await mutation.mutateAsync({
          email: input.email.trim(),
          senha: input.password,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
        });
        return {
          user: { email: input.email.trim(), nomeExibicao: input.email.trim() },
          expiraEm: serializeDate(result.expiraEm),
          // aperture-d7993 — `criado` is the server's authoritative login-vs-
          // create branch (Rex #273, `as const` discriminated union → clean
          // narrowing). true = new account (→ onboarding); false = login.
          criado: result.criado,
        };
      } catch (err) {
        throw toAuthError(err, "continuarComEmail");
      }
    },
    [mutation],
  );

  return { continuarComEmail, isPending: mutation.isPending };
}

export function useSignOut() {
  const utils = trpc.useUtils();
  const mutation = trpc.auth.signOut.useMutation({
    onSuccess: () => {
      void utils.auth.me.invalidate();
    },
  });

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await mutation.mutateAsync();
    } catch {
      // signOut is idempotent on the server — a network failure here would
      // be cosmetic. The cookie may still be set; the next `me()` will
      // either reaffirm the session (server was unreachable) or clear
      // (server saw the request). Either way the UI doesn't error.
    }
  }, [mutation]);

  return { signOut, isPending: mutation.isPending };
}

/**
 * Current-user probe. Returns `null` when not signed in. SSR-safe — runs as
 * a client-side fetch after hydration (TrpcProvider doesn't prefetch yet).
 */
export function useMe() {
  return trpc.auth.me.useQuery(undefined, {
    // The cookie can change without a router event (server set-cookie on
    // signUp/signIn/signOut), so we invalidate explicitly from those
    // mutations rather than relying on focus-refetch.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * tRPC's superjson-less default serializes `Date` to an ISO string on the
 * wire. We accept either shape and normalise to string so callers don't
 * have to care.
 */
function serializeDate(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return new Date().toISOString();
}
