import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { trpc } from "@/lib/trpc";
import { isLegacy, needsOnboarding } from "@/lib/onboarding-gate";
import type { AuthSession } from "@/lib/auth";
import { AuthModalShell, type AuthMode } from "./AuthModalShell.js";
import { OnboardingWizard } from "./OnboardingWizard.js";

// aperture-nop8l — AuthModalProvider
// aperture-tgkh3 — Post-auth navigation wired here (vs the shell) so every
// consumer that summons the modal (landing CTAs, future authed-page guards,
// the auth-demo page) gets the same redirect-to-/painel/<slug> behaviour
// for free. The shell already exposes `onAuthenticated`; we plug into it.
//
// Singleton auth modal mounted at the App.tsx tree root. Any descendant
// can summon it via `useAuthModal()` — landing CTAs, painel header,
// future authenticated-page guards, etc. Centralising the state here
// guarantees:
//   - one modal in the DOM at a time (no doubled backdrops if two
//     callers fire `open()` near-simultaneously)
//   - shared step/email state across triggers (useful when the user
//     opens signin from one CTA, dismisses, then opens signup from
//     another — email survives via the modal's own state machine)
//   - focus restoration to whatever element actually triggered the open,
//     even when that element lives in a totally different component
//     than the AuthModalShell render site
//   - one redirect policy (aperture-tgkh3) for every entry point
//
// Public API:
//   <AuthModalProvider>{children}</AuthModalProvider>
//   const auth = useAuthModal();
//   auth.open("signin", btnRef.current);
//   auth.close();
//   auth.setMode("signup");
//   auth.state.isOpen | auth.state.mode
//
// The Provider renders the AuthModalShell itself when state.isOpen is
// true — consumers do NOT need to render the shell.

export interface AuthModalState {
  isOpen: boolean;
  mode: AuthMode;
}

export interface AuthModalContextValue {
  state: AuthModalState;
  open: (mode: AuthMode, trigger?: HTMLElement | null) => void;
  close: () => void;
  setMode: (next: AuthMode) => void;
}

const AuthModalContext = createContext<AuthModalContextValue | null>(null);

export function AuthModalProvider({
  children,
  initialMode = "signin",
}: {
  children: ReactNode;
  /** Mode to use the first time `open()` is called without an explicit mode. */
  initialMode?: AuthMode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setModeState] = useState<AuthMode>(initialMode);
  const triggerRef = useRef<HTMLElement | null>(null);
  // aperture-84a21 — a fresh signup opens the onboarding wizard (slug + baby
  // name + event date/type) instead of redirecting straight to the painel.
  const [showOnboarding, setShowOnboarding] = useState(false);

  // tRPC utils for fetching the freshly-authenticated user's slug
  // (aperture-tgkh3). The signUp / signIn mutations already invalidate
  // `auth.me` on success (see lib/auth.ts), so `utils.auth.me.fetch()`
  // here will hit the network and pick up the user the cookie now points
  // at — including their slug.
  const utils = trpc.useUtils();

  const open = useCallback((next: AuthMode, trigger?: HTMLElement | null) => {
    // Stash the trigger (or the currently-focused element as a fallback) so
    // the modal returns focus on close. SSR-safe — document is only touched
    // inside this client-only handler.
    triggerRef.current =
      trigger ??
      (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setModeState(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const setMode = useCallback((next: AuthMode) => {
    setModeState(next);
  }, []);

  // ── Post-auth navigation (aperture-tgkh3) ────────────────────────────────
  //
  // Fired by AuthModalShell after a successful signUp / signIn (and after
  // the success toast). We don't trust the mutation response for slug —
  // signUp/signIn return only {idUsuario,idConta,expiraEm} (Rex's PR #61
  // contract). Instead we read `auth.me` fresh: the mutations have
  // already invalidated it, so .fetch() goes to network and returns the
  // newly-authenticated user with their slug.
  //
  // Self-redirect guard: if the user already happens to be on their own
  // painel (rare — e.g. they typed the URL, hit "Entrar", signed in),
  // skip the reload. Anywhere else, full-page navigate so the SSR side
  // of the painel route gets the freshly-set cookie and renders the
  // authenticated dashboard server-side.
  //
  // Failure modes — never strand the user inside the modal:
  //   - me() returns null (race: cookie already expired) → stay put,
  //     navbar will rerender to anonymous on its own
  //   - slug missing on the response (shouldn't happen post-khbow but
  //     belt-and-braces) → stay put, modal is already closed
  //   - fetch throws (network blip mid-success) → stay put
  //
  // The user is already signed in at this point (cookie set), so leaving
  // them on the current page with an updated navbar is graceful
  // degradation.
  const onAuthenticated = useCallback(
    async (session: AuthSession) => {
      // aperture-d7993 — the unified email-first flow (continuarComEmail) hands
      // us `session.criado`: the server's authoritative login-vs-create branch.
      // A brand-NEW account goes through the onboarding wizard first (it captures
      // slug + babyName + dataEvento + tipoEvento, then redirects to the painel);
      // an existing LOGIN gets the straight redirect. This replaces the old
      // `mode === "signup"` heuristic, which was wrong once a single entry could
      // resolve to either outcome at submit time.
      if (session.criado) {
        setShowOnboarding(true);
        return;
      }
      try {
        const me = await utils.auth.me.fetch();
        if (!me?.slug) return;
        // aperture-g7l09 (multicampanha POC) — post-login default lands on
        // /campanhas (the mixed 1.0/2.0 bridge). The me.slug guard stays:
        // it's the session-validity probe.
        //
        // aperture-ivu2t — EXCEPT accounts that still need onboarding: a
        // fresh OAuth signup that reaches this path (session.criado only
        // covers the in-modal email flow) has no campaign data and /campanhas
        // offers only the stub NOVA LISTA — a dead end. Route them to their
        // painel instead, where PainelPage mounts the blocking
        // OnboardingWizard (the normal creation flow). needsOnboarding() is
        // the server-authoritative, provider-agnostic gate (aperture-8ysqu).
        // aperture-duk6x — LEGACY FIRST (operator-found bug): a fresh legacy
        // user is migrating from 1.0, not creating their first 2.0 list — the
        // migration hub with their 1.0 card outranks the onboarding wizard.
        const target = isLegacy(me)
          ? '/campanhas'
          : needsOnboarding(me)
            ? `/painel/${me.slug}`
            : '/campanhas';
        if (typeof window === "undefined") return;
        if (window.location.pathname === target) return;
        window.location.assign(target);
      } catch {
        // Graceful degradation — see comment above.
      }
    },
    [utils],
  );

  // Focus restoration. Runs AFTER the modal has unmounted (next animation
  // frame) so the dialog's focus trap doesn't fight us for the focus target.
  useEffect(() => {
    if (isOpen) return;
    const t = triggerRef.current;
    if (!t) return;
    const id = window.requestAnimationFrame(() => {
      t.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen]);

  const value: AuthModalContextValue = { state: { isOpen, mode }, open, close, setMode };

  return (
    <AuthModalContext.Provider value={value}>
      {children}
      {isOpen && (
        <AuthModalShell
          mode={mode}
          onClose={close}
          onModeChange={setMode}
          onAuthenticated={onAuthenticated}
        />
      )}
      {showOnboarding && (
        <OnboardingWizard
          onDone={(slug) => {
            setShowOnboarding(false);
            if (typeof window !== "undefined") {
              window.location.assign(`/painel/${slug}`);
            }
          }}
        />
      )}
    </AuthModalContext.Provider>
  );
}

/**
 * Access the singleton AuthModal from any descendant of {@link AuthModalProvider}.
 *
 * Throws if called outside the provider — fail loud rather than silently
 * giving the consumer a dead handle.
 */
export function useAuthModal(): AuthModalContextValue {
  const ctx = useContext(AuthModalContext);
  if (!ctx) {
    throw new Error(
      "useAuthModal() must be used inside an <AuthModalProvider>. " +
        "Mount the provider at the App.tsx tree root.",
    );
  }
  return ctx;
}
