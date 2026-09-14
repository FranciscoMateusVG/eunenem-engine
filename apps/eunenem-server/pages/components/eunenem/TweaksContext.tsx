
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  TWEAKS_DEFAULTS,
  type TweaksState,
} from "@/lib/mocks/tweaksDefaults";
import {
  type EditableDraft,
  type EditField,
  isDirty as computeDirty,
} from "@/lib/inline-edit";

// aperture-3d9t — TweaksContext.
//
// In-memory live customisation of baby name + parents + due date +
// primary/accent colours. Colour changes are mirrored onto CSS vars
// on `document.documentElement` so the whole page reads the new
// palette from the cascade — no per-component prop-drilling for
// colours.
//
// Reload resets state (no localStorage by operator constraint).
//
// aperture-whxzg — this context is THE single store for the owner inline
// editor on /pagina/:slug (no second editor/store competing with the
// palette). Three additions, all optional for existing callers:
//   • `historia` + `fotoCapaUrl/fotoPerfilUrl/fotoHistoriaUrl` preview
//     overrides on TweaksState (Hero/Story prefer them over their props).
//   • a SAVED BASELINE snapshot of the editable half → `dirty`,
//     `resetToBaseline()` (Cancelar) and `markSaved()` (after Salvar /
//     after a photo persists).
//   • editor UI state → `openEditor(field)` from the contextual page icons,
//     consumed by TweaksPanel to open + focus the exact input.

interface EditorUiState {
  open: boolean;
  /** Field to focus once the panel is open; cleared after focus lands. */
  focusField: EditField | null;
  /** Monotonic nonce so re-clicking the SAME icon re-focuses. */
  focusNonce: number;
}

interface TweaksContextValue {
  tweaks: TweaksState;
  setTweak: <K extends keyof TweaksState>(
    key: K,
    value: TweaksState[K],
  ) => void;
  setTweaks: (partial: Partial<TweaksState>) => void;
  /** Saved half — what Cancelar restores and what dirty compares against. */
  baseline: EditableDraft;
  dirty: boolean;
  /** Snapshot the CURRENT (or given) editable values as the saved baseline. */
  markSaved: (saved?: Partial<TweaksState>) => void;
  /** Cancelar — discard unsaved text/colour edits (photos already persisted stay). */
  resetToBaseline: () => void;
  editor: EditorUiState;
  openEditor: (field?: EditField) => void;
  closeEditor: () => void;
  clearFocusRequest: () => void;
}

const TweaksContext = createContext<TweaksContextValue | null>(null);

function draftOf(state: TweaksState): EditableDraft {
  return {
    babyName: state.babyName,
    parents: state.parents,
    historia: state.historia ?? "",
    primary: state.primary,
    accent: state.accent,
  };
}

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
  const [baseline, setBaseline] = useState<EditableDraft>(() =>
    draftOf({ ...TWEAKS_DEFAULTS, ...initialState }),
  );
  const [editor, setEditor] = useState<EditorUiState>({
    open: false,
    focusField: null,
    focusNonce: 0,
  });
  // Latest state for markSaved (no setState-inside-updater).
  const tweaksRef = useRef(tweaks);
  tweaksRef.current = tweaks;

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

  const markSaved = useCallback<TweaksContextValue["markSaved"]>((saved) => {
    const next = saved ? { ...tweaksRef.current, ...saved } : tweaksRef.current;
    tweaksRef.current = next;
    setTweaksState(next);
    setBaseline(draftOf(next));
  }, []);

  const resetToBaseline = useCallback(() => {
    setTweaksState((prev) => ({
      ...prev,
      babyName: baseline.babyName,
      parents: baseline.parents,
      historia: baseline.historia,
      primary: baseline.primary,
      accent: baseline.accent,
    }));
  }, [baseline]);

  const openEditor = useCallback((field?: EditField) => {
    setEditor((prev) => ({
      open: true,
      focusField: field ?? null,
      focusNonce: prev.focusNonce + 1,
    }));
  }, []);
  const closeEditor = useCallback(() => {
    setEditor((prev) => ({ ...prev, open: false, focusField: null }));
  }, []);
  const clearFocusRequest = useCallback(() => {
    setEditor((prev) => (prev.focusField ? { ...prev, focusField: null } : prev));
  }, []);

  const dirty = useMemo(() => computeDirty(draftOf(tweaks), baseline), [tweaks, baseline]);

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

  const value = useMemo<TweaksContextValue>(
    () => ({
      tweaks,
      setTweak,
      setTweaks,
      baseline,
      dirty,
      markSaved,
      resetToBaseline,
      editor,
      openEditor,
      closeEditor,
      clearFocusRequest,
    }),
    [
      tweaks,
      setTweak,
      setTweaks,
      baseline,
      dirty,
      markSaved,
      resetToBaseline,
      editor,
      openEditor,
      closeEditor,
      clearFocusRequest,
    ],
  );

  return (
    <TweaksContext.Provider value={value}>
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
