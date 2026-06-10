// aperture-7nius — Floating bottom-right TUTORIAL re-trigger CTA.
//
// Plan 0018 locked decision #5: visible to all users (completed or not).
// Clicking it re-opens the overlay from step 1 regardless of state — the
// parent owns the open/close state and listens to `onOpen`. Hidden during
// the active overlay (the page is dimmed; the floating CTA would just be
// dead pixels).

interface PainelTutorialTriggerProps {
  /** Hide while the overlay itself is open. */
  visible: boolean;
  /** Fires when the user clicks the floating button. */
  onOpen: () => void;
}

export function PainelTutorialTrigger({
  visible,
  onOpen,
}: PainelTutorialTriggerProps) {
  if (!visible) return null;
  return (
    <button
      type="button"
      className="painel-tutorial-trigger"
      onClick={onOpen}
      aria-label="abrir tutorial"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        width={18}
        height={18}
        aria-hidden="true"
      >
        {/* Open book / lightbulb hybrid — matches the "tutorial" affordance
         *  in the reference screenshots. */}
        <path d="M2 19V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v13" />
        <path d="M22 19V6a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v13" />
        <line x1="2" y1="19" x2="22" y2="19" />
      </svg>
      <span>TUTORIAL</span>
    </button>
  );
}
