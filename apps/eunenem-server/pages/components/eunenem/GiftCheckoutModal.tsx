
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { useEffect, useMemo, useState } from "react";
import { useIniciarPagamentoContribuicao } from "@/lib/paginaApi";
import { getStripePromise } from "@/lib/stripeClient";
import type { VisitorGift } from "@/lib/visitorGift";

// aperture-3xgch — two-step checkout modal.
//
// Step 1 — Contribuinte form:
//   visitor enters their nome + email. We need both to attach the
//   contribuinte to the contribuicao server-side. The recadinho is NOT
//   collected here — Stripe collects it via custom_fields during step 2.
//
// Step 2 — Stripe Embedded Checkout:
//   on form submit we fire iniciarPagamentoContribuicao mutation. On
//   success the server returns { clientSecret, sessionId }; we mount the
//   EmbeddedCheckoutProvider with the clientSecret and Stripe takes over
//   the payment UI inline. return_url is set server-side (Rex's C2) to
//   /pagina/<slug>/sucesso?sessionId={CHECKOUT_SESSION_ID}.
//
// Accessibility (unchanged from aperture-3d9t):
//   - Esc closes (disabled mid-checkout to avoid losing payment state)
//   - Backdrop click closes
//   - role="dialog" + aria-modal + aria-labelledby
//   - autofocus on first input
//   - body scroll lock
//
// Visual language: EuNenem cream/lilac/plum palette, Caveat for the
// rotated labels, Patrick Hand for the price.

interface GiftCheckoutModalProps {
  gift: VisitorGift;
  babyName: string;
  slug: string;
  onClose: () => void;
}

type Step = "form" | "stripe";

export function GiftCheckoutModal({
  gift,
  babyName,
  slug,
  onClose,
}: GiftCheckoutModalProps) {
  const [step, setStep] = useState<Step>("form");
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");

  const iniciarPagamento = useIniciarPagamentoContribuicao();
  const stripePromise = useMemo(() => getStripePromise(), []);

  // Esc to close. Block while Stripe is mounted to avoid dropping a
  // half-completed payment.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step === "form" && !iniciarPagamento.isPending) {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, step, iniciarPagamento.isPending]);

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const canClose = step === "form" && !iniciarPagamento.isPending;
  const formInvalid = nome.trim().length < 2 || !email.includes("@");

  async function onSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    if (!gift.availableId || iniciarPagamento.isPending || formInvalid) return;
    try {
      await iniciarPagamento.mutateAsync({
        slug,
        idContribuicao: gift.availableId,
        contribuinte: { nome: nome.trim(), email: email.trim() },
      });
      setStep("stripe");
    } catch {
      // Error state is read off `iniciarPagamento.error` below — stay on
      // the form step so the visitor can retry or close.
    }
  }

  const clientSecret = iniciarPagamento.data?.clientSecret;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gift-checkout-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
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
        overflowY: "auto",
      }}
    >
      <div
        style={{
          background: "var(--paper)",
          borderRadius: 24,
          padding: step === "stripe" ? 0 : 28,
          width: "100%",
          maxWidth: step === "stripe" ? 560 : 460,
          boxShadow: "var(--shadow-lg)",
          position: "relative",
          maxHeight: "calc(100vh - 32px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <button
          type="button"
          onClick={() => canClose && onClose()}
          disabled={!canClose}
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
            cursor: canClose ? "pointer" : "not-allowed",
            fontWeight: 700,
            lineHeight: 1,
            zIndex: 2,
          }}
        >
          ×
        </button>

        {step === "form" && (
          <form onSubmit={onSubmitForm} style={{ display: "flex", flexDirection: "column" }}>
            <span className="eyebrow eyebrow-coral" style={{ fontSize: 22 }}>
              presentear
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
              {gift.nome}
            </h3>
            <p
              style={{
                color: "var(--ink-soft)",
                fontSize: 14.5,
                lineHeight: 1.5,
                marginBottom: 18,
              }}
            >
              R$ {gift.priceBRL} — paga com Pix ou cartão no checkout seguro
              do Stripe. Você deixa o recadinho pro {babyName} no próximo
              passo ♡
            </p>

            <label
              htmlFor="checkout-nome"
              style={{
                display: "block",
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 22,
                color: "var(--plum)",
                marginBottom: 6,
                transform: "rotate(-1deg)",
              }}
            >
              seu nome ♡
            </label>
            <input
              id="checkout-nome"
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              autoFocus
              required
              minLength={2}
              maxLength={80}
              placeholder="Como vai assinar o recadinho"
              disabled={iniciarPagamento.isPending}
              style={INPUT_STYLE}
            />

            <label
              htmlFor="checkout-email"
              style={{
                display: "block",
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 22,
                color: "var(--plum)",
                marginBottom: 6,
                marginTop: 14,
                transform: "rotate(-1deg)",
              }}
            >
              seu email ♡
            </label>
            <input
              id="checkout-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={120}
              placeholder="pra mandar o comprovante"
              disabled={iniciarPagamento.isPending}
              style={INPUT_STYLE}
            />
            <p
              style={{
                fontSize: 12,
                color: "var(--ink-mute)",
                marginTop: 6,
                marginBottom: 18,
              }}
            >
              Usamos só pra te mandar o comprovante. Não enviamos newsletter,
              prometido.
            </p>

            {iniciarPagamento.isError && (
              <div
                role="alert"
                style={{
                  background: "var(--pink-soft)",
                  color: "var(--plum)",
                  padding: "12px 14px",
                  borderRadius: 14,
                  marginBottom: 14,
                  fontSize: 13.5,
                  lineHeight: 1.4,
                }}
              >
                deu ruim ao iniciar o pagamento — tenta de novo daqui a pouco
                ♡
              </div>
            )}

            <button
              type="submit"
              disabled={iniciarPagamento.isPending || formInvalid || !gift.availableId}
              className="btn-lilac"
              style={{
                width: "100%",
                justifyContent: "center",
                opacity:
                  iniciarPagamento.isPending || formInvalid || !gift.availableId ? 0.7 : 1,
              }}
            >
              {iniciarPagamento.isPending
                ? "Abrindo checkout..."
                : `Continuar pro pagamento →`}
            </button>
            <p
              style={{
                fontSize: 11,
                color: "var(--ink-mute)",
                textAlign: "center",
                marginTop: 10,
              }}
            >
              Pagamento processado pelo Stripe — Pix ou cartão de crédito.
            </p>
          </form>
        )}

        {step === "stripe" && clientSecret && (
          <div
            style={{
              minHeight: 480,
              padding: 18,
              overflow: "hidden",
              borderRadius: 24,
            }}
          >
            <EmbeddedCheckoutProvider
              stripe={stripePromise}
              options={{ clientSecret }}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        )}
      </div>
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: 14,
  borderRadius: 16,
  border: "1.5px solid var(--line)",
  fontSize: 15,
  fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
  color: "var(--ink)",
  lineHeight: 1.5,
  background: "var(--cream)",
  outline: "none",
  transition: "border-color 0.2s ease",
};
