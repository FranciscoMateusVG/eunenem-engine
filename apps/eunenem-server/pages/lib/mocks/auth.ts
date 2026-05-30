// aperture-ubpnl — mock auth contract for the AuthModalShell scaffold.
//
// This file pins the SHAPE the modal speaks to so the UI can ship now and
// the real client swaps in when Rex's aperture-ht7sq (eunenem-server tRPC
// mount of the auth router) lands. The mock and the real client are bound
// by the procedure surface declared here:
//
//   signUp({ email, password, name }) -> { user, sessionToken }
//   signIn({ email, password })       -> { user, sessionToken }
//   signOut()                         -> void
//   me()                              -> { user } | null
//
// When the real chain ships, callers swap `import { auth } from "@/lib/mocks/auth"`
// for `import { trpc } from "@/lib/trpc"; const auth = trpc.auth;` (or
// equivalent — exact swap shape determined by ht7sq's procedure naming).
// The component code does NOT change.
//
// Each mock call inserts an 800ms delay so the modal's loading state (CTA
// disabled + spinner) is visible during development. Real procedures will
// remove that delay; loading state then reflects actual network time.

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  sessionToken: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

/** Discriminated error type so the UI can render the right field message. */
export type AuthError =
  | { kind: "invalid-email" }
  | { kind: "short-password"; minLength: number }
  | { kind: "credentials" }
  | { kind: "email-taken" }
  | { kind: "network" };

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
    case "network":
      return "deu ruim na conexão — tenta de novo daqui a pouco ♡";
  }
}

// ── Mock procedure implementations ──────────────────────────────────────────

const MOCK_DELAY_MS = 800;
const MIN_PASSWORD_LEN = 6;

function delay(ms = MOCK_DELAY_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUser(email: string, name: string): AuthUser {
  return {
    id: `user_mock_${Math.random().toString(36).slice(2, 10)}`,
    email,
    name,
    createdAt: new Date().toISOString(),
  };
}

function makeSession(user: AuthUser): AuthSession {
  return {
    user,
    sessionToken: `mock_${user.id}_${Math.random().toString(36).slice(2, 14)}`,
  };
}

/** RFC5322-lite — matches `local@domain.tld` shapes the user actually types. */
export function isValidEmail(email: string): boolean {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Mock signUp — always succeeds unless email looks taken (mock heuristic). */
export async function signUp(input: SignUpInput): Promise<AuthSession> {
  await delay();
  if (!isValidEmail(input.email)) {
    throw { kind: "invalid-email" } satisfies AuthError;
  }
  if (input.password.length < MIN_PASSWORD_LEN) {
    throw { kind: "short-password", minLength: MIN_PASSWORD_LEN } satisfies AuthError;
  }
  // Mock heuristic: a couple of fixed emails simulate already-taken state so
  // the UI can exercise the error path during dev verification.
  if (TAKEN_EMAILS.has(input.email.toLowerCase())) {
    throw { kind: "email-taken" } satisfies AuthError;
  }
  return makeSession(makeUser(input.email, input.name || input.email.split("@")[0]!));
}

/** Mock signIn — accepts the demo creds + rejects any other email/password. */
export async function signIn(input: SignInInput): Promise<AuthSession> {
  await delay();
  if (!isValidEmail(input.email)) {
    throw { kind: "invalid-email" } satisfies AuthError;
  }
  if (input.password.length < MIN_PASSWORD_LEN) {
    throw { kind: "short-password", minLength: MIN_PASSWORD_LEN } satisfies AuthError;
  }
  const demo = DEMO_CREDS.get(input.email.toLowerCase());
  if (!demo || demo.password !== input.password) {
    throw { kind: "credentials" } satisfies AuthError;
  }
  return makeSession(demo.user);
}

/** Mock signOut — local-only; production will clear the session cookie. */
export async function signOut(): Promise<void> {
  await delay(200);
}

/** Mock me — always returns null in v1. Real impl reads the session cookie. */
export async function me(): Promise<{ user: AuthUser } | null> {
  await delay(120);
  return null;
}

/** Single import surface so consumers can later swap `auth` for a real client. */
export const auth = { signUp, signIn, signOut, me } as const;

// ── Dev-only helpers (used by AuthDemoPage to surface error states) ─────────

const TAKEN_EMAILS = new Set<string>(["taken@eunenem.com"]);

const DEMO_CREDS = new Map<string, { password: string; user: AuthUser }>([
  [
    "helena@eunenem.com",
    {
      password: "abc123",
      user: {
        id: "user_demo_helena",
        email: "helena@eunenem.com",
        name: "Helena",
        createdAt: "2026-05-01T12:00:00.000Z",
      },
    },
  ],
]);

/** Read-only view for the demo page's hint copy. */
export const AUTH_DEMO_HINTS = {
  signInEmail: "helena@eunenem.com",
  signInPassword: "abc123",
  takenSignupEmail: "taken@eunenem.com",
  minPasswordLength: MIN_PASSWORD_LEN,
} as const;
