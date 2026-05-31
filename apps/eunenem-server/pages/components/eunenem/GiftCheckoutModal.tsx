
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useIniciarPagamentoContribuicao,
  type MetodoPagamento,
} from "@/lib/paginaApi";
import { getStripePromise } from "@/lib/stripeClient";
import type { VisitorGift } from "@/lib/visitorGift";

// aperture-3xgch (scaffold) + aperture-ra027 (real wiring + metodo step).
//
// THREE-STEP checkout flow:
//
//   1. form    — visitor enters nome + email (needed by the saga to attach
//                the contribuinte to the contribuicao server-side).
//   2. metodo  — visitor picks Pix vs Cartão. The mutation needs `metodo` as
//                input so Rex's iniciarPagamentoContribuicao saga can build
//                the right Stripe session shape. UI defaults to Pix (the
//                fee-free path for our 10% margin); both methods feel valid
//                — no badge, no surcharge UI, the default IS the recommendation.
//   3. stripe  — EmbeddedCheckoutProvider mounts with the clientSecret
//                returned from the mutation. Stripe collects recadinho via
//                custom_fields and redirects to /pagina/<slug>/sucesso?
//                sessionId={CHECKOUT_SESSION_ID} on completion.
//
// Esc/backdrop: allowed on form + metodo (no payment in flight), BLOCKED on
// stripe (don't drop a half-completed payment). Also blocked while the
// mutation is pending.

interface GiftCheckoutModalProps {
  gift: VisitorGift;
  babyName: string;
  slug: string;
  onClose: () => void;
}

type Step = "form" | "metodo" | "stripe";

export function GiftCheckoutModal({
  gift,
  babyName,
  slug,
  onClose,
}: GiftCheckoutModalProps) {
  const [step, setStep] = useState<Step>("form");
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [metodo, setMetodo] = useState<MetodoPagamento>("pix");

  const iniciarPagamento = useIniciarPagamentoContribuicao();
  const stripePromise = useMemo(() => getStripePromise(), []);

  // Esc to close. Allowed on form + metodo; blocked once Stripe is mounted
  // or a mutation is in flight.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (step === "stripe" || iniciarPagamento.isPending) return;
      onClose();
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

  const canClose = step !== "stripe" && !iniciarPagamento.isPending;
  const formInvalid = nome.trim().length < 2 || !email.includes("@");

  function onSubmitForm(e: React.FormEvent) {
    e.preventDefault();
    if (formInvalid || !gift.availableId) return;
    setStep("metodo");
  }

  async function onConfirmMetodo() {
    if (!gift.availableId || iniciarPagamento.isPending) return;
    try {
      await iniciarPagamento.mutateAsync({
        slug,
        idContribuicao: gift.availableId,
        contribuinte: { nome: nome.trim(), email: email.trim() },
        metodo,
      });
      setStep("stripe");
    } catch {
      // Error state surfaces via iniciarPagamento.isError on the metodo step.
      // Stay on the metodo step so the visitor can retry or go back.
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
          <FormStep
            gift={gift}
            babyName={babyName}
            nome={nome}
            setNome={setNome}
            email={email}
            setEmail={setEmail}
            formInvalid={formInvalid}
            onSubmit={onSubmitForm}
          />
        )}

        {step === "metodo" && (
          <MetodoStep
            gift={gift}
            metodo={metodo}
            setMetodo={setMetodo}
            onBack={() => setStep("form")}
            onContinue={onConfirmMetodo}
            isPending={iniciarPagamento.isPending}
            isError={iniciarPagamento.isError}
          />
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

// ── Step: contribuinte form ───────────────────────────────────────────────

function FormStep({
  gift,
  babyName,
  nome,
  setNome,
  email,
  setEmail,
  formInvalid,
  onSubmit,
}: {
  gift: VisitorGift;
  babyName: string;
  nome: string;
  setNome: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  formInvalid: boolean;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column" }}>
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
        R$ {gift.priceBRL} — vai direto pros papais do {babyName}. Em
        seguida você escolhe como pagar e deixa um recadinho ♡
      </p>

      <label
        htmlFor="checkout-nome"
        style={LABEL_STYLE}
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
        style={INPUT_STYLE}
      />

      <label
        htmlFor="checkout-email"
        style={{ ...LABEL_STYLE, marginTop: 14 }}
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

      <button
        type="submit"
        disabled={formInvalid || !gift.availableId}
        className="btn-lilac"
        style={{
          width: "100%",
          justifyContent: "center",
          opacity: formInvalid || !gift.availableId ? 0.7 : 1,
        }}
      >
        Continuar →
      </button>
    </form>
  );
}

// ── Step: metodo picker (Pix vs Cartão) ───────────────────────────────────

function MetodoStep({
  gift,
  metodo,
  setMetodo,
  onBack,
  onContinue,
  isPending,
  isError,
}: {
  gift: VisitorGift;
  metodo: MetodoPagamento;
  setMetodo: (m: MetodoPagamento) => void;
  onBack: () => void;
  onContinue: () => void;
  isPending: boolean;
  isError: boolean;
}) {
  const pixRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLButtonElement | null>(null);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setMetodo("pix");
      pixRef.current?.focus();
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setMetodo("credit_card");
      cardRef.current?.focus();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span className="eyebrow eyebrow-coral" style={{ fontSize: 22 }}>
        como você quer pagar?
      </span>
      <h3
        id="gift-checkout-title"
        style={{
          fontSize: 26,
          color: "var(--plum)",
          marginTop: 8,
          marginBottom: 6,
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
          marginBottom: 22,
        }}
      >
        R$ {gift.priceBRL} — os dois caem direto no Pix dos papais ♡
      </p>

      <div
        role="radiogroup"
        aria-label="Forma de pagamento"
        onKeyDown={onKeyDown}
        className="metodo-grid"
      >
        <MetodoCard
          ref={pixRef}
          selected={metodo === "pix"}
          onSelect={() => setMetodo("pix")}
          icon="⚡"
          title="Pix"
          micro="na hora ♡"
          sub="aprovado em segundos"
        />
        <MetodoCard
          ref={cardRef}
          selected={metodo === "credit_card"}
          onSelect={() => setMetodo("credit_card")}
          icon="💳"
          title="Cartão"
          micro="até 12x"
          sub="Visa, Master, Elo, Amex"
        />
      </div>

      {isError && (
        <div
          role="alert"
          style={{
            background: "var(--pink-soft)",
            color: "var(--plum)",
            padding: "12px 14px",
            borderRadius: 14,
            marginTop: 16,
            fontSize: 13.5,
            lineHeight: 1.4,
          }}
        >
          deu ruim ao iniciar o pagamento — tenta de novo daqui a pouco ♡
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 12,
          marginTop: 22,
          alignItems: "center",
        }}
        className="metodo-actions"
      >
        <button
          type="button"
          onClick={onBack}
          disabled={isPending}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--ink-soft)",
            fontFamily: "var(--font-dm-sans), system-ui, sans-serif",
            fontSize: 14,
            fontWeight: 600,
            cursor: isPending ? "not-allowed" : "pointer",
            padding: "10px 4px",
            opacity: isPending ? 0.5 : 1,
          }}
        >
          ← voltar
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={isPending}
          className="btn-lilac"
          style={{
            flex: 1,
            justifyContent: "center",
            opacity: isPending ? 0.7 : 1,
          }}
        >
          {isPending ? "Abrindo checkout..." : "Continuar →"}
        </button>
      </div>
      <p
        style={{
          fontSize: 11,
          color: "var(--ink-mute)",
          textAlign: "center",
          marginTop: 10,
        }}
      >
        Pagamento processado pelo Stripe — você deixa o recadinho lá ♡
      </p>
    </div>
  );
}

// ── Single Pix/Cartão card (radiogroup option) ────────────────────────────

interface MetodoCardProps {
  selected: boolean;
  onSelect: () => void;
  icon: string;
  title: string;
  micro: string;
  sub: string;
}

const MetodoCard = function MetodoCardInner({
  ref,
  selected,
  onSelect,
  icon,
  title,
  micro,
  sub,
}: MetodoCardProps & { ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={selected ? "metodo-card metodo-card--selected" : "metodo-card"}
    >
      <span aria-hidden="true" className="metodo-card-icon">
        {icon}
      </span>
      <span className="metodo-card-title">{title}</span>
      <span className="metodo-card-micro">{micro}</span>
      <span className="metodo-card-sub">{sub}</span>
    </button>
  );
};

// ── Shared styles ─────────────────────────────────────────────────────────

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

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--font-caveat), cursive",
  fontSize: 22,
  color: "var(--plum)",
  marginBottom: 6,
  transform: "rotate(-1deg)",
};
