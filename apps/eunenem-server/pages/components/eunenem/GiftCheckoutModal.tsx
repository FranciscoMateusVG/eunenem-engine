
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

// aperture-3xgch (scaffold) → aperture-ra027 (real wiring + metodo step)
// → aperture-kx9bl (drop contribuinte form — Stripe is source of truth).
//
// TWO-STEP checkout flow (was three steps, the contribuinte form is gone):
//
//   1. metodo  — visitor picks Pix vs Cartão. Pix default-selected (the
//                fee-free path for our 10% margin); both methods feel valid
//                — no badge, no surcharge UI, the default IS the
//                recommendation.
//   2. stripe  — EmbeddedCheckoutProvider mounts with the clientSecret
//                returned from the mutation. Stripe collects nome + email +
//                mensagem (recadinho) NATIVELY inside the iframe via
//                custom_fields + customer_creation. The webhook then
//                persists those fields server-side.
//
// Operator caught the scope drift during the live walk: collecting nome +
// email in our modal before mounting Stripe asked the visitor for the same
// info twice (once from us, once from Stripe). One place is enough — let
// Stripe do it. See aperture-kx9bl + sibling backend bead aperture-m95f3.
//
// Esc/backdrop: allowed on metodo (no payment in flight), BLOCKED on stripe
// (don't drop a half-completed payment). Also blocked while the mutation is
// pending.

interface GiftCheckoutModalProps {
  gift: VisitorGift;
  babyName: string;
  slug: string;
  onClose: () => void;
}

type Step = "metodo" | "stripe";

export function GiftCheckoutModal({
  gift,
  babyName: _babyName,
  slug,
  onClose,
}: GiftCheckoutModalProps) {
  const [step, setStep] = useState<Step>("metodo");
  const [metodo, setMetodo] = useState<MetodoPagamento>("pix");

  const iniciarPagamento = useIniciarPagamentoContribuicao();
  const stripePromise = useMemo(() => getStripePromise(), []);

  // Esc to close. Blocked only during the brief iniciar mutation window —
  // operator's mental model is "Esc closes the modal" and Stripe abandons
  // sessions naturally on close. Pagamento stays pending and is webhook-
  // finalized only on real payment success, so closing mid-Stripe is safe
  // (aperture-4e4jt).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (iniciarPagamento.isPending) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, iniciarPagamento.isPending]);

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // X / backdrop / Esc all share this gate. Blocked only during the brief
  // iniciar mutation network call (we'd corrupt the saga compensation
  // window). Open during Stripe — visitor can always abandon; Stripe's
  // session expires + our Pagamento stays pending until the webhook
  // finalizes a real payment (aperture-4e4jt).
  const canClose = !iniciarPagamento.isPending;

  async function onConfirmMetodo() {
    if (!gift.availableId || iniciarPagamento.isPending) return;
    try {
      await iniciarPagamento.mutateAsync({
        slug,
        idContribuicao: gift.availableId,
        metodo,
      });
      setStep("stripe");
    } catch {
      // Error state surfaces via iniciarPagamento.isError on the metodo step.
      // Stay on the metodo step so the visitor can retry or close.
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

        {step === "metodo" && (
          <MetodoStep
            gift={gift}
            metodo={metodo}
            setMetodo={setMetodo}
            onContinue={onConfirmMetodo}
            isPending={iniciarPagamento.isPending}
            isError={iniciarPagamento.isError}
          />
        )}

        {step === "stripe" && clientSecret && (
          <div
            style={{
              // aperture-4e4jt — Stripe iframe content can exceed the
              // modal's maxHeight on cramped viewports (mobile after URL
              // bar, short windows). flex: 1 lets this wrapper claim the
              // remaining height inside the modal's flex column;
              // minHeight: 0 unlocks the standard flex-item shrink
              // behaviour; overflowY: auto turns the wrapper into a
              // scroll container so the Stripe iframe is always reachable.
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: 18,
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

// ── Step: metodo picker (Pix vs Cartão) — now the entry surface ───────────

function MetodoStep({
  gift,
  metodo,
  setMetodo,
  onContinue,
  isPending,
  isError,
}: {
  gift: VisitorGift;
  metodo: MetodoPagamento;
  setMetodo: (m: MetodoPagamento) => void;
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
        presentear
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
        escolhe como pagar. Você deixa um recadinho bonito no checkout ♡
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
          priceLabel={formatBRL(gift.valorCents)}
          micro="na hora ♡"
          sub="aprovado em segundos"
        />
        <MetodoCard
          ref={cardRef}
          selected={metodo === "credit_card"}
          onSelect={() => setMetodo("credit_card")}
          icon="💳"
          title="Cartão"
          priceLabel={formatBRL(gift.valorComTaxaCartaoCents ?? gift.valorCents)}
          micro={
            gift.valorComTaxaCartaoCents !== null &&
            gift.valorComTaxaCartaoCents > gift.valorCents
              ? `+${formatBRL(
                  gift.valorComTaxaCartaoCents - gift.valorCents,
                )} taxa cartão`
              : "até 12x"
          }
          sub="Visa, Master, Elo, Amex · até 12x"
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

      <button
        type="button"
        onClick={onContinue}
        disabled={isPending}
        className="btn-lilac"
        style={{
          width: "100%",
          justifyContent: "center",
          marginTop: 22,
          opacity: isPending ? 0.7 : 1,
        }}
      >
        {isPending ? "Abrindo checkout..." : "Continuar →"}
      </button>
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
  /** Final price label shown under the title — Patrick Hand, plum, bold.
   *  Includes any surcharge (Cartão card shows valor + taxa total). */
  priceLabel: string;
  micro: string;
  sub: string;
}

const MetodoCard = function MetodoCardInner({
  ref,
  selected,
  onSelect,
  icon,
  title,
  priceLabel,
  micro,
  sub,
}: MetodoCardProps & { ref?: React.Ref<HTMLButtonElement> }) {
  // Compose an accessible name so screen readers reading the radio surface
  // include the final price + the microcopy summary, not just "Pix" /
  // "Cartão". The visible price line is also exposed; this is belt-and-
  // suspenders for the surcharge announcement on selection.
  const accessibleLabel = `${title}, ${priceLabel}, ${micro}`;
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={accessibleLabel}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={selected ? "metodo-card metodo-card--selected" : "metodo-card"}
    >
      <span aria-hidden="true" className="metodo-card-icon">
        {icon}
      </span>
      <span className="metodo-card-title">{title}</span>
      <span className="metodo-card-price">{priceLabel}</span>
      <span className="metodo-card-micro">{micro}</span>
      <span className="metodo-card-sub">{sub}</span>
    </button>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Format integer cents as BRL with comma decimal separator (Brazilian
 *  convention). 4500 → "R$ 45,00", 4723 → "R$ 47,23". */
function formatBRL(cents: number): string {
  const reais = cents / 100;
  return `R$ ${reais.toFixed(2).replace(".", ",")}`;
}
