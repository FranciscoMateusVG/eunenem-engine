import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthMode } from "./AuthModalShell";

// aperture-ubpnl — useAuthModal
//
// Consumer-friendly hook for opening the AuthModalShell from anywhere in the
// app. Returns:
//   - open(mode, trigger?)  → opens the modal at the given mode; remembers
//                             the trigger element so focus restores on close
//   - close()               → dismisses the modal
//   - setMode(next)         → swap signin↔signup in place (used internally
//                             by the modal's footer cross-link)
//   - state                 → { isOpen, mode } — drive `<AuthModalShell />`
//
// Usage:
//   const auth = useAuthModal();
//   <button ref={btnRef} onClick={() => auth.open("signin", btnRef.current)}>
//     Entrar
//   </button>
//   {auth.state.isOpen && (
//     <AuthModalShell
//       mode={auth.state.mode}
//       onClose={auth.close}
//       onModeChange={auth.setMode}
//     />
//   )}
//
// Focus restoration: on open, the hook stashes the currently-focused element
// (or an explicit trigger you pass in). On close, focus returns to it. The
// AuthModalShell handles in-modal focus trap separately.

export interface AuthModalState {
  isOpen: boolean;
  mode: AuthMode;
}

export interface UseAuthModalReturn {
  state: AuthModalState;
  open: (mode: AuthMode, trigger?: HTMLElement | null) => void;
  close: () => void;
  setMode: (next: AuthMode) => void;
}

export function useAuthModal(initialMode: AuthMode = "signin"): UseAuthModalReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setModeState] = useState<AuthMode>(initialMode);
  const triggerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((next: AuthMode, trigger?: HTMLElement | null) => {
    // Stash the trigger (or whatever has focus right now) so we can restore
    // focus to it when the modal closes. Falls back to the active element
    // if no trigger was passed — covers cases where the caller doesn't
    // ref the button.
    triggerRef.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setModeState(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const setMode = useCallback((next: AuthMode) => {
    setModeState(next);
  }, []);

  // Focus restoration. We run this AFTER the modal has unmounted (next tick)
  // so the dialog's focus trap doesn't fight us for the focus target.
  useEffect(() => {
    if (isOpen) return;
    const t = triggerRef.current;
    if (!t) return;
    // Defer one frame so any closing animation completes before focus moves.
    const id = window.requestAnimationFrame(() => {
      t.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen]);

  return { state: { isOpen, mode }, open, close, setMode };
}
