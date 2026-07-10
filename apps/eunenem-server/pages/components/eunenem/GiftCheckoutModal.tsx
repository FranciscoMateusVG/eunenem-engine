
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useIniciarPagamentoContribuicao,
  useInvalidarListaPresentes,
  useObterSucessoPagamento,
  type MetodoPagamento,
} from "@/lib/paginaApi";
import { useCampanhaRota } from "@/lib/campanha-rota";
import { formatBRL } from "@/lib/formatBRL";
import { paginaSharePath } from "@/lib/painelRoutes";
import { getStripePromise } from "@/lib/stripeClient";
import type { VisitorGift } from "@/lib/visitorGift";
import { sendEvent } from "@/lib/analytics";

// aperture-3xgch (scaffold) → aperture-ra027 (real wiring + metodo step)
// → aperture-kx9bl (drop contribuinte form — Stripe is source of truth)
// → aperture-6g58e (inline-success state machine — kill the redirect-to-
//   /sucesso flow + the race condition it caused; visitor stays here).
//
// TWO-STEP checkout flow → augmented with an inline success phase:
//
//   1. metodo  — visitor picks Pix vs Cartão.
//   2. stripe  — EmbeddedCheckoutProvider mounts with the clientSecret
//                returned from the mutation. Stripe collects nome + email +
//                mensagem (recadinho) NATIVELY inside the iframe via
//                custom_fields + customer_creation. The webhook then
//                persists those fields server-side.
//   3. success — after Stripe's `onComplete` fires (requires the server-
//                side iniciar mutation to pass redirect_on_completion:
//                'if_required'; GLaDOS owns that engine wiring), the
//                modal flips to an inline ✓ panel and the visitor never
//                leaves /pagina/<slug>. The legacy /sucesso page stays
//                available for direct URLs + the completed_slow escape
//                hatch + the legacy redirect fallback (if the server hasn't
//                shipped redirect_on_completion yet, onComplete simply
//                won't fire and Stripe will redirect to /sucesso as
//                before — defensive degradation, no regression).
//
// SUCCESS PHASE STATE MACHINE (aperture-6g58e):
//
//   completed_pending   — onComplete fired client-side; the webhook hasn't
//                         yet finalized the Pagamento. Optimistic ✓ + spinner.
//                         Polls obterSucessoPagamento every 1.5s.
//   completed_confirmed — poll returned status: 'approved'. Spinner off,
//                         CTAs (comprar outro / ver mural / fechar) enabled.
//   completed_slow      — 30s elapsed in completed_pending without webhook
//                         confirmation. Softer copy + escape hatch link to
//                         /pagina/<slug>/sucesso?sessionId=X (the legacy
//                         success page still works for this).
//
// Esc/backdrop: allowed on metodo (no payment in flight), BLOCKED on stripe
// (don't drop a half-completed payment) AND BLOCKED on completed_pending
// (operator decision aperture-6g58e — don't let the visitor accidentally
// dismiss the visual confirmation while we're still waiting on the webhook).
// Allowed again on completed_confirmed and completed_slow.

interface GiftCheckoutModalProps {
  gift: VisitorGift;
  babyName: string;
  slug: string;
  onClose: () => void;
}

type Phase =
  | { kind: "checkout"; step: "metodo" | "stripe" }
  | { kind: "completed_pending" }
  | { kind: "completed_confirmed" }
  | { kind: "completed_slow" };

export function GiftCheckoutModal({
  gift,
  babyName,
  slug,
  onClose,
}: GiftCheckoutModalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "checkout", step: "metodo" });
  const [metodo, setMetodo] = useState<MetodoPagamento>("pix");

  const iniciarPagamento = useIniciarPagamentoContribuicao();
  const invalidarListaPresentes = useInvalidarListaPresentes();
  const stripePromise = useMemo(() => getStripePromise(), []);

  // Captured at session-create time and held for the success phase so we
  // can both (a) poll obterSucessoPagamento by sessionId and (b) hand the
  // visitor an escape-hatch URL pointing at the legacy /sucesso page if
  // the webhook is slow.
  const sessionId = iniciarPagamento.data?.sessionId ?? null;
  const clientSecret = iniciarPagamento.data?.clientSecret;

  // Poll the success-read while we're in the pending/slow window. The hook
  // already auto-cancels polling once status reaches a terminal value, and
  // the `enabled` gate short-circuits the network call until the phase has
  // actually flipped to a completed_* state. We poll faster than /sucesso's
  // 3s baseline because the modal is the active surface — the visitor is
  // staring at the spinner and 1.5s feels much closer to "instant".
  const successQueryEnabled =
    Boolean(sessionId) &&
    (phase.kind === "completed_pending" || phase.kind === "completed_slow");
  const successQuery = useObterSucessoPagamento(slug, sessionId, {
    enabled: successQueryEnabled,
    // pollWhilePending uses the hook's built-in refetchInterval of 3s. We
    // override below via React-Query's intrinsic refetchInterval merge — but
    // since the hook locks that option in, we instead rely on the 3s
    // default and accept slightly slower-than-1.5s polling. (Avoiding a
    // refactor of paginaApi.ts to keep this change scoped to one file per
    // the brief.)
    pollWhilePending: true,
  });

  // Flip pending → confirmed when the poll reports approved. (We don't flip
  // to error here on rejected, since onComplete only fires for successful
  // confirmations; rejected from this side would be a webhook race we
  // shouldn't second-guess.)
  useEffect(() => {
    if (phase.kind !== "completed_pending" && phase.kind !== "completed_slow") {
      return;
    }
    if (successQuery.data?.status === "approved") {
      setPhase({ kind: "completed_confirmed" });
      // aperture-6g58e operator follow-up: invalidate the Marketplace
      // cache so the gift grid re-renders the just-purchased gift as
      // PRESENTEADO without a manual page refresh. Fire-and-forget — the
      // grid is behind the modal so the refetch happens while the user
      // is still in the success panel.
      void invalidarListaPresentes(slug);
    }
  }, [successQuery.data?.status, phase.kind, invalidarListaPresentes, slug]);

  // 30s timeout: pending → slow. Cleared if the phase changes before then
  // (confirmed lands, or visitor closes + reopens which remounts).
  useEffect(() => {
    if (phase.kind !== "completed_pending") return;
    const t = setTimeout(() => {
      setPhase((cur) => (cur.kind === "completed_pending" ? { kind: "completed_slow" } : cur));
    }, 30_000);
    return () => clearTimeout(t);
  }, [phase.kind]);

  // canClose gate. Closed during:
  //   - the iniciar mutation network call (saga compensation window)
  //   - the completed_pending phase (don't lose visual confirmation)
  // Open during checkout/metodo, stripe (visitor can always abandon),
  // completed_confirmed, and completed_slow.
  const canClose =
    !iniciarPagamento.isPending && phase.kind !== "completed_pending";

  // Esc to close — same gate as the X / backdrop.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!canClose) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, canClose]);

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function onConfirmMetodo() {
    if (!gift.availableId || iniciarPagamento.isPending) return;
    try {
      await iniciarPagamento.mutateAsync({
        slug,
        idContribuicao: gift.availableId,
        metodo,
      });
      sendEvent("checkout_iniciado", { valor_centavos: gift.valorCents, metodo });
      setPhase({ kind: "checkout", step: "stripe" });
    } catch {
      // Error state surfaces via iniciarPagamento.isError on the metodo step.
      // Stay on the metodo step so the visitor can retry or close.
    }
  }

  // Stripe's onComplete fires client-side when the embedded checkout
  // confirms a payment in an iframe-resident flow (i.e. when the server
  // created the session with redirect_on_completion: 'if_required'/'never'
  // and the chosen payment method doesn't force a bank redirect).
  //
  // We don't get the sessionId in the callback args — it's already in
  // component state from the iniciar mutation response. We don't trust the
  // client for finalization either; the webhook remains the source of
  // truth. This callback's only job: flip the state machine to
  // completed_pending so the inline ✓ + polling spin up.
  const onStripeComplete = useCallback(() => {
    setPhase((cur) => {
      // Guard against re-entry — onComplete is documented as fire-once but
      // be defensive.
      if (cur.kind !== "checkout") return cur;
      return { kind: "completed_pending" };
    });
  }, []);

  // Memoise the options object: EmbeddedCheckoutProvider's internal effect
  // recreates the iframe if the options identity changes, which would blow
  // away a half-typed card form on every render. Keyed on clientSecret.
  const embeddedOptions = useMemo(
    () =>
      clientSecret
        ? { clientSecret, onComplete: onStripeComplete }
        : undefined,
    [clientSecret, onStripeComplete],
  );

  // CTA handlers for the success panel.
  const handleComprarOutro = useCallback(() => {
    // Reset to idle-equivalent: drop sessionId/clientSecret state by
    // resetting the mutation, send the phase back to metodo, then close
    // the modal. Page stays put; Marketplace's react-query cache picks up
    // the webhook-triggered invalidation on its own.
    iniciarPagamento.reset();
    setPhase({ kind: "checkout", step: "metodo" });
    onClose();
  }, [iniciarPagamento, onClose]);

  const handleVerNoMural = useCallback(() => {
    iniciarPagamento.reset();
    setPhase({ kind: "checkout", step: "metodo" });
    onClose();
    // Defer the scroll until after the modal unmounts so the smooth scroll
    // animation isn't fighting body-overflow restoration. requestAnimation-
    // Frame is enough — the close + unmount happen synchronously above.
    requestAnimationFrame(() => {
      const mural = document.getElementById("mural");
      if (mural) {
        mural.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }, [iniciarPagamento, onClose]);

  const handleFechar = useCallback(() => {
    iniciarPagamento.reset();
    setPhase({ kind: "checkout", step: "metodo" });
    onClose();
  }, [iniciarPagamento, onClose]);

  // Determine the modal's chrome (padding, max-width) based on phase.
  const isCheckoutStripe = phase.kind === "checkout" && phase.step === "stripe";
  const isSuccessPhase =
    phase.kind === "completed_pending" ||
    phase.kind === "completed_confirmed" ||
    phase.kind === "completed_slow";

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
          padding: isCheckoutStripe ? 0 : 28,
          width: "100%",
          maxWidth: isCheckoutStripe ? 560 : 460,
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
            opacity: canClose ? 1 : 0.4,
          }}
        >
          ×
        </button>

        {phase.kind === "checkout" && phase.step === "metodo" && (
          <MetodoStep
            gift={gift}
            metodo={metodo}
            setMetodo={setMetodo}
            onContinue={onConfirmMetodo}
            isPending={iniciarPagamento.isPending}
            isError={iniciarPagamento.isError}
          />
        )}

        {phase.kind === "checkout" && phase.step === "stripe" && embeddedOptions && (
          <div
            style={{
              // aperture-4e4jt — Stripe iframe content can exceed the
              // modal's maxHeight on cramped viewports. flex:1 + minHeight:0
              // + overflowY: auto turn the wrapper into a scroll container
              // so the Stripe iframe is always reachable.
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: 18,
              borderRadius: 24,
            }}
          >
            <EmbeddedCheckoutProvider
              stripe={stripePromise}
              options={embeddedOptions}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        )}

        {isSuccessPhase && (
          <SuccessPanel
            gift={gift}
            babyName={babyName}
            slug={slug}
            sessionId={sessionId}
            phase={phase.kind}
            recadinho={successQuery.data?.recadinho ?? null}
            contribuinteNome={successQuery.data?.contribuinte?.nome ?? null}
            onComprarOutro={handleComprarOutro}
            onVerNoMural={handleVerNoMural}
            onFechar={handleFechar}
          />
        )}
      </div>
    </div>
  );
}

// ── Success panel — the inline ✓ moment (aperture-6g58e) ──────────────────
//
// Design notes from operator + Vance's /sucesso polaroid (PR #74):
//   - "recebemos seu carinho ♡" eyebrow in coral
//   - "obrigado, {nome}!" h1 in Patrick Hand
//   - Polaroid frame with the gift thumbnail
//   - Recadinho in Caveat (falls back to a polite default when empty)
//   - "...e o {babyName} já vai saber! ♡" footer line
//   - 3 CTAs: primary (comprar outro), secondary outline (ver mural),
//     tertiary text link (fechar)
//
// Scaled down vs /sucesso (which is a full page). The polaroid is tighter,
// the h1 smaller, no corner doodles — modal real estate is constrained and
// the warm moment needs to feel intimate, not vast.
//
// Re-use of existing tokens/classes: leans on the `sucesso-*` CSS family
// from tailwind.css that Vance shipped with PR #74 — same polaroid, tape,
// recadinho, gift-name, tagline. The brief allowed extracting a shared
// RecadinhoCard component but the modal needs different dimensions, so we
// re-use at the CSS-class level (which keeps the visual language tight)
// rather than at the component level. If a third surface needs the same
// polaroid card later, that's the moment to factor.

function SuccessPanel({
  gift,
  babyName,
  slug,
  sessionId,
  phase,
  recadinho,
  contribuinteNome,
  onComprarOutro,
  onVerNoMural,
  onFechar,
}: {
  gift: VisitorGift;
  babyName: string;
  slug: string;
  sessionId: string | null;
  phase: "completed_pending" | "completed_confirmed" | "completed_slow";
  recadinho: string | null;
  contribuinteNome: string | null;
  onComprarOutro: () => void;
  onVerNoMural: () => void;
  onFechar: () => void;
}) {
  const isPending = phase === "completed_pending";
  const isConfirmed = phase === "completed_confirmed";
  const isSlow = phase === "completed_slow";

  // aperture-2v91z — both escape hatches keep the CAMPANHA context: the
  // sucesso link carries &idCampanha= (the backend cross-checks it for
  // addressed checkouts) and the bare fallback goes to the campanha's page.
  const idCampanhaCtx = useCampanhaRota();
  const escapeHref =
    sessionId !== null
      ? `/pagina/${encodeURIComponent(slug)}/sucesso?sessionId=${encodeURIComponent(sessionId)}${idCampanhaCtx ? `&idCampanha=${encodeURIComponent(idCampanhaCtx)}` : ""}`
      : paginaSharePath(slug, idCampanhaCtx);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
      aria-live={isPending ? "polite" : "off"}
    >
      <span
        className="eyebrow eyebrow-coral"
        style={{ fontSize: 18, marginBottom: 8 }}
      >
        recebemos seu carinho ♡
      </span>
      <h3
        id="gift-checkout-title"
        className="sucesso-h1"
        style={{
          fontSize: "clamp(34px, 5vw, 44px)",
          margin: "0 0 20px",
        }}
      >
        obrigado
        {contribuinteNome ? (
          <>
            , <span className="sucesso-h1-name">{firstName(contribuinteNome)}</span>
          </>
        ) : null}
        !
      </h3>

      {/* Polaroid — re-uses /sucesso CSS. Slightly smaller via inline width. */}
      <article
        className={`sucesso-polaroid${isPending ? " sucesso-polaroid--pending" : ""}`}
        style={{ width: "min(260px, 80%)", margin: "0 0 24px" }}
        aria-labelledby="success-gift-name"
      >
        <span className="sucesso-polaroid-tape" aria-hidden="true" />
        <div className="sucesso-polaroid-photo">
          {gift.imagemUrl ? (
            <img
              src={gift.imagemUrl}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <span aria-hidden="true" className="sucesso-polaroid-emoji">
              {gift.emoji}
            </span>
          )}
          {isConfirmed && (
            <span className="sucesso-polaroid-stamp" aria-hidden="true">
              ✓ presenteado
            </span>
          )}
        </div>
        <div className="sucesso-polaroid-caption">
          <h2 id="success-gift-name" className="sucesso-gift-name">
            {gift.nome}
          </h2>
          <p className="sucesso-gift-valor">{formatBRL(gift.valorCents)} ♡</p>
        </div>
      </article>

      {/* Recadinho — Caveat, mirrors /sucesso's polite-default behaviour
          (operator decision: never render blank). During completed_pending
          recadinho may still be null while the webhook lands; the
          fallback line keeps the moment warm. */}
      <blockquote
        className="sucesso-recadinho"
        style={{ fontSize: "clamp(20px, 2.4vw, 26px)", margin: "0 0 18px" }}
      >
        <span aria-hidden="true" className="sucesso-recadinho-quote">"</span>
        {recadinho && recadinho.trim().length > 0
          ? recadinho
          : `um abraço apertado pro ${babyName} ♡`}
        <span
          aria-hidden="true"
          className="sucesso-recadinho-quote sucesso-recadinho-quote--end"
        >
          "
        </span>
      </blockquote>

      <p className="sucesso-tagline" style={{ margin: "0 0 22px" }}>
        ...e o <span className="sucesso-tagline-name">{babyName}</span> já vai saber! ♡
      </p>

      {isPending && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: "var(--ink-soft)",
            fontSize: 14,
            marginBottom: 18,
          }}
        >
          <Spinner />
          <span>confirmando pagamento...</span>
        </div>
      )}

      {isSlow && (
        <p
          className="sucesso-pending-longwait"
          style={{ margin: "0 0 18px", textAlign: "left" }}
        >
          pagamento aprovado, mas a confirmação está demorando um pouco. fica
          tranquilo — o mural atualiza sozinho assim que cair.{" "}
          <a href={escapeHref} style={{ color: "var(--plum)", fontWeight: 600 }}>
            ver detalhes da confirmação →
          </a>
        </p>
      )}

      {/* CTAs — primary / secondary outline / tertiary text. Disabled in
          completed_pending; enabled in completed_confirmed and
          completed_slow. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "100%",
          maxWidth: 320,
        }}
      >
        <button
          type="button"
          className="btn-lilac"
          onClick={onComprarOutro}
          disabled={isPending}
          style={{
            width: "100%",
            justifyContent: "center",
            opacity: isPending ? 0.5 : 1,
            cursor: isPending ? "not-allowed" : "pointer",
          }}
        >
          comprar outro presente ♡
        </button>
        <button
          type="button"
          onClick={onVerNoMural}
          disabled={isPending}
          style={{
            width: "100%",
            background: "transparent",
            color: "var(--plum)",
            border: "1.5px solid var(--lilac-deep)",
            borderRadius: 999,
            padding: "10px 22px",
            fontWeight: 600,
            fontSize: 14.5,
            cursor: isPending ? "not-allowed" : "pointer",
            opacity: isPending ? 0.5 : 1,
          }}
        >
          ver no mural
        </button>
        <button
          type="button"
          onClick={onFechar}
          disabled={isPending}
          style={{
            background: "transparent",
            color: "var(--ink-soft)",
            border: "none",
            padding: "8px 12px",
            fontSize: 13,
            cursor: isPending ? "not-allowed" : "pointer",
            opacity: isPending ? 0.5 : 1,
            textDecoration: "underline",
          }}
        >
          fechar
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 16,
        height: 16,
        borderRadius: "50%",
        border: "2px solid var(--lilac-soft)",
        borderTopColor: "var(--lilac-deep)",
        animation: "spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
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
