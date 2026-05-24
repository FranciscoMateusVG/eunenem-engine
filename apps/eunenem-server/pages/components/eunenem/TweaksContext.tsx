
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  TWEAKS_DEFAULTS,
  type TweaksState,
} from "@/lib/mocks/tweaksDefaults";

// aperture-3d9t — TweaksContext.
//
// In-memory live customisation of baby name + parents + due date +
// primary/accent colours. Colour changes are mirrored onto CSS vars
// on `document.documentElement` so the whole page reads the new
// palette from the cascade — no per-component prop-drilling for
// colours.
//
// Reload resets state (no localStorage by operator constraint).

interface TweaksContextValue {
  tweaks: TweaksState;
  setTweak: <K extends keyof TweaksState>(
    key: K,
    value: TweaksState[K],
  ) => void;
  setTweaks: (partial: Partial<TweaksState>) => void;
}

const TweaksContext = createContext<TweaksContextValue | null>(null);

export function TweaksProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  /**
   * Optional partial override of TWEAKS_DEFAULTS — useful when the
   * route already knows part of the answer (e.g. /painel/[slug] seeds
   * babyName from the slug so the page reads "página da helena" on
   * first paint instead of the v1 demo default "francisco"). The
   * Tweaks panel still drives all subsequent edits.
   */
  initialState?: Partial<TweaksState>;
}) {
  const [tweaks, setTweaksState] = useState<TweaksState>(() => ({
    ...TWEAKS_DEFAULTS,
    ...initialState,
  }));

  const setTweak = useCallback<TweaksContextValue["setTweak"]>(
    (key, value) => {
      setTweaksState((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const setTweaks = useCallback<TweaksContextValue["setTweaks"]>(
    (partial) => {
      setTweaksState((prev) => ({ ...prev, ...partial }));
    },
    [],
  );

  // Mirror colour tweaks onto CSS vars on document root. Whole-page
  // utilities + tokens read these — no prop-drilling needed for
  // colour changes.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--lilac", tweaks.primary);
    root.setProperty("--lilac-deep", tweaks.primaryDeep);
    root.setProperty("--lilac-soft", tweaks.primarySoft);
    root.setProperty("--coral-pink", tweaks.accent);
  }, [
    tweaks.primary,
    tweaks.primaryDeep,
    tweaks.primarySoft,
    tweaks.accent,
  ]);

  return (
    <TweaksContext.Provider value={{ tweaks, setTweak, setTweaks }}>
      {children}
    </TweaksContext.Provider>
  );
}

export function useTweaks(): TweaksContextValue {
  const ctx = useContext(TweaksContext);
  if (!ctx) {
    throw new Error("useTweaks must be used within a TweaksProvider");
  }
  return ctx;
}
