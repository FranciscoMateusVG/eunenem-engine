
import { useEffect, useState } from "react";
import type { Gift } from "@/lib/mocks/gifts";

// aperture-3d9t — mock checkout modal.
//
// Operator constraint: "Pix mocked." Clicking the pay button fires a
// 1-second fake delay then resolves via the parent's onConfirm — which
// handles the toast + card flip + mural insert.
//
// Accessibility:
// - Esc key closes
// - Focus-trap-light: autofocus the textarea on open
// - Backdrop click closes
// - role="dialog" + aria-modal="true" + aria-labelledby

interface GiftCheckoutModalProps {
  gift: Gift;
  babyName: string;
  onClose: () => void;
  onConfirm: (note: string) => Promise<void>;
}

export function GiftCheckoutModal({
  gift,
  babyName,
  onClose,
  onConfirm,
}: GiftCheckoutModalProps) {
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Esc to close. Don't allow closing while submitting.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, isSubmitting]);

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(note);
    } finally {
      // onConfirm closes the modal via the parent state, so we don't
      // need to setIsSubmitting(false) — the component will unmount.
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gift-checkout-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(107, 60, 94, 0.45)",
        backdropFilter: "blur(6px)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: "var(--paper)",
          borderRadius: 24,
          padding: 28,
          width: "100%",
          maxWidth: 460,
          boxShadow: "var(--shadow-lg)",
          position: "relative",
        }}
      >
        <button
          type="button"
          onClick={() => !isSubmitting && onClose()}
          disabled={isSubmitting}
          aria-label="Fechar"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--cream-2)",
            color: "var(--ink-soft)",
            border: "none",
            fontSize: 18,
            cursor: isSubmitting ? "not-allowed" : "pointer",
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          ×
        </button>

        <span className="eyebrow eyebrow-coral" style={{ fontSize: 22 }}>
          finalizar presente
        </span>
        <h3
          id="gift-checkout-title"
          style={{
            fontSize: 28,
            color: "var(--plum)",
            marginTop: 8,
            marginBottom: 8,
            lineHeight: 1.1,
          }}
        >
          {gift.name}
        </h3>
        <p
          style={{
            color: "var(--ink-soft)",
            fontSize: 14.5,
            lineHeight: 1.5,
            marginBottom: 18,
          }}
        >
          R$ {gift.priceBRL} — vai direto no Pix dos papais.
        </p>

        <label
          htmlFor="checkout-note"
          style={{
            display: "block",
            fontFamily: "var(--font-caveat), cursive",
            fontSize: 22,
            color: "var(--plum)",
            marginBottom: 6,
            transform: "rotate(-1deg)",
          }}
        >
          Deixe seu recadinho pro {babyName} ♡
        </label>
        <textarea
          id="checkout-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
          rows={4}
          maxLength={280}
          placeholder={`Mandando muito amor pro ${babyName}...`}
          disabled={isSubmitting}
          style={{
            width: "100%",
            padding: 14,
            borderRadius: 16,
            border: "1.5px solid var(--line)",
            fontSize: 15,
            fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
            color: "var(--ink)",
            lineHeight: 1.5,
            background: "var(--cream)",
            resize: "vertical",
            minHeight: 100,
            outline: "none",
            transition: "border-color 0.2s ease",
          }}
        />
        <p
          style={{
            fontSize: 12,
            color: "var(--ink-mute)",
            marginTop: 6,
            marginBottom: 20,
          }}
        >
          O recadinho aparece no mural junto com os outros. Carinho não
          se mede em caracteres — mas no máximo 280.
        </p>

        <button
          type="submit"
          disabled={isSubmitting}
          className="btn-lilac"
          style={{
            width: "100%",
            justifyContent: "center",
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          {isSubmitting
            ? "Processando..."
            : `Pagar R$ ${gift.priceBRL} com Pix (mocked)`}
        </button>
        <p
          style={{
            fontSize: 11,
            color: "var(--ink-mute)",
            textAlign: "center",
            marginTop: 10,
          }}
        >
          Pagamento simulado — nenhum valor real será cobrado.
        </p>
      </form>
    </div>
  );
}
