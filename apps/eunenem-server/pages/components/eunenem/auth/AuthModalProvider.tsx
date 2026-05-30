import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AuthModalShell, type AuthMode } from "./AuthModalShell.js";

// aperture-nop8l — AuthModalProvider
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
      {isOpen && <AuthModalShell mode={mode} onClose={close} onModeChange={setMode} />}
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
