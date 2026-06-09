import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useIniciarPagamentoCarrinho,
  useInvalidarListaPresentes,
  useObterSucessoPagamento,
  usePaginaListaPresentes,
  type MetodoPagamento,
} from "@/lib/paginaApi";
import {
  useCart,
  revalidateAgainstFresh,
  type CartLine,
} from "@/lib/cart.js";
import { formatBRL } from "@/lib/formatBRL";
import { getStripePromise } from "@/lib/stripeClient";
import { groupVisitorGifts } from "@/lib/visitorGift";

// Plan 0017 / aperture-16flf — visitor cart drawer + checkout flow.
//
// Right-side slide-in drawer that holds the cart's full lifecycle in one
// chrome: summary (line items + qty controls + method picker) → stripe
// (embedded checkout iframe) → success (inline ✓ panel). Mirrors the
// state machine GiftCheckoutModal established for single-shot purchases
// (aperture-6g58e — completed_pending / completed_confirmed / completed_slow),
// adapted for the multi-item flow.
//
// Why one component for all phases: each phase needs continuity with the
// last. After Stripe's onComplete fires the success panel reads "obrigada
// pelos N presentes" — the cart line snapshot survives across phases so
// the copy stays accurate even though the cart itself was cleared on the
// successful mutation. A modal-per-phase would force ceremony around
// passing state through.
//
// Drawer chrome:
//   - Slides in from the right (transform: translateX(0) when open)
//   - Fixed full-height column, max 460px wide, scrollable body
//   - Lilac-soft border-l + paper bg + lg shadow
//   - Backdrop dims the page; click-backdrop closes (when canClose)

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
  slug: string;
}

type Phase =
  | { kind: "summary" }
  | { kind: "checkout"; step: "stripe" }
  | { kind: "completed_pending" }
  | { kind: "completed_confirmed" }
  | { kind: "completed_slow" };

export function CartDrawer({ open, onClose, slug }: CartDrawerProps) {
  const cart = useCart();
  const [phase, setPhase] = useState<Phase>({ kind: "summary" });
  const [metodo, setMetodo] = useState<MetodoPagamento>("pix");
  // Snapshot the lines + their pre-checkout totals at the moment the
  // visitor confirms — used for the success-panel copy after the cart
  // itself has been cleared.
  const [checkoutSnapshot, setCheckoutSnapshot] = useState<{
    lines: readonly CartLine[];
    totalUnits: number;
    totalCents: number;
  } | null>(null);

  const iniciar = useIniciarPagamentoCarrinho();
  const invalidarListaPresentes = useInvalidarListaPresentes();

  const sessionId = iniciar.data?.sessionId ?? null;
  const clientSecret = iniciar.data?.clientSecret ?? null;

  // Poll the success endpoint while we're in pending/slow so we can flip
  // to confirmed the moment the webhook lands.
  const successQueryEnabled =
    phase.kind === "completed_pending" || phase.kind === "completed_slow";
  const successQuery = useObterSucessoPagamento(slug, sessionId, {
    enabled: successQueryEnabled,
    pollWhilePending: true,
  });

  useEffect(() => {
    if (phase.kind !== "completed_pending" && phase.kind !== "completed_slow") {
      return;
    }
    if (successQuery.data?.status === "approved") {
      setPhase({ kind: "completed_confirmed" });
      void invalidarListaPresentes(slug);
    }
  }, [successQuery.data?.status, phase.kind, invalidarListaPresentes, slug]);

  // 30s pending → slow timeout.
  useEffect(() => {
    if (phase.kind !== "completed_pending") return;
    const t = setTimeout(() => {
      setPhase((cur) =>
        cur.kind === "completed_pending" ? { kind: "completed_slow" } : cur,
      );
    }, 30_000);
    return () => clearTimeout(t);
  }, [phase.kind]);

  // canClose gates the X / backdrop / Esc. Closed during the iniciar
  // mutation (saga compensation window) + completed_pending (visual
  // confirmation must survive).
  const canClose = !iniciar.isPending && phase.kind !== "completed_pending";

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!canClose) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, canClose]);

  // Lock body scroll while the drawer is open (mirrors GiftCheckoutModal).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // aperture-qxntg — refetch list at finalize so we re-validate against
  // FRESH availableIds. The cart line captures availableIds at add-time
  // (per the visitorGift projection); between add + finalize another
  // visitor (or admin action) can flip a row to aprovado. Without this
  // refetch, the cart would happily ship a now-sold row-id and the
  // saga's per-item esgotada gate would 500.
  const listQuery = usePaginaListaPresentes(slug);

  const onFinalizar = useCallback(async () => {
    if (cart.state.lines.length === 0 || iniciar.isPending) return;

    // aperture-qxntg — force a fresh fetch before we ship. ensureData
    // returns the latest snapshot (refetches if stale per the 30s
    // staleTime); we then re-derive saga input from those fresh
    // availableIds rather than the cart line's potentially-stale
    // snapshot. Falls back to the cart's snapshot if the refetch
    // throws (network blip) — better to attempt the saga than block
    // the visitor on a transient list refetch failure; the saga's own
    // esgotada gate is the safety net.
    let freshList = listQuery.data;
    try {
      freshList = await listQuery.refetch().then((r) => r.data ?? freshList);
    } catch {
      // Leave freshList at its cached snapshot.
    }
    const freshGifts = freshList ? groupVisitorGifts(freshList) : [];

    const { itens, raced } = revalidateAgainstFresh(
      cart.state.lines,
      freshGifts,
    );

    // Race-recovery: decrement any line whose available count dropped
    // below the visitor's wanted quantidade between add + finalize.
    // The visitor sees the updated count + a friendly toast; they
    // re-click Finalizar to ship with the trimmed cart.
    if (raced.length > 0) {
      for (const r of raced) {
        const dropBy = Math.max(0, cart.quantidadeFor(r.nome) - r.available);
        for (let i = 0; i < dropBy; i++) {
          cart.decrement(r.nome);
        }
      }
      const firstNome = raced[0]?.nome ?? "esse mimo";
      toast(
        raced.length === 1
          ? `${firstNome} acabou de ser presenteado por outra pessoa ♡ ajustamos seu carrinho`
          : `alguns mimos acabaram de ser presenteados ♡ ajustamos seu carrinho`,
      );
      // Don't fire the mutation if anything raced — let the visitor
      // confirm the new cart before paying. They can re-click
      // Finalizar.
      return;
    }

    if (itens.length === 0) return;

    setCheckoutSnapshot({
      lines: cart.state.lines.slice(),
      totalUnits: cart.totalUnits,
      totalCents: metodo === "pix" ? cart.totalPixCents : cart.totalCartaoCents,
    });
    try {
      await iniciar.mutateAsync({
        slug,
        itens: itens.map((item) => ({
          idContribuicao: item.idContribuicao,
          quantidade: item.quantidade,
        })),
        metodo,
      });
      setPhase({ kind: "checkout", step: "stripe" });
    } catch {
      // Error surfaces via iniciar.isError on the summary panel.
      // Stay on summary; reset snapshot so the visitor can edit + retry.
      setCheckoutSnapshot(null);
    }
  }, [
    cart,
    iniciar,
    listQuery,
    metodo,
    slug,
  ]);

  const onStripeComplete = useCallback(() => {
    setPhase((cur) => (cur.kind === "checkout" ? { kind: "completed_pending" } : cur));
  }, []);

  const embeddedOptions = useMemo(
    () =>
      clientSecret
        ? { clientSecret, onComplete: onStripeComplete }
        : undefined,
    [clientSecret, onStripeComplete],
  );

  const handleSuccessClose = useCallback(() => {
    // Cart is cleared the moment we entered completed_pending — at the
    // moment of close we reset everything else (mutation, snapshot,
    // phase) so a future cart starts cleanly.
    cart.clear();
    iniciar.reset();
    setCheckoutSnapshot(null);
    setPhase({ kind: "summary" });
    onClose();
  }, [cart, iniciar, onClose]);

  // The cart clears optimistically when we transition to completed_pending
  // (operator-confirmed payment intent; the webhook is the final word but
  // the visitor's experience is "I bought it"). This unmounts the items
  // from the marketplace too once the invalidation lands.
  useEffect(() => {
    if (phase.kind === "completed_pending") {
      cart.clear();
    }
  }, [phase.kind, cart]);

  if (!open && phase.kind === "summary") {
    return null;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={canClose ? onClose : undefined}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(107, 60, 94, 0.40)",
          backdropFilter: "blur(4px)",
          zIndex: 49,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />
      {/* Drawer panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(460px, 100vw)",
          background: "var(--paper)",
          borderLeft: "1px solid var(--lilac-soft)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 50,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.30s cubic-bezier(0.4, 0, 0.2, 1)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <DrawerHeader
          phase={phase}
          canClose={canClose}
          onClose={canClose ? onClose : undefined}
        />

        {phase.kind === "summary" && (
          <SummaryStep
            metodo={metodo}
            setMetodo={setMetodo}
            onFinalizar={onFinalizar}
            isPending={iniciar.isPending}
            isError={iniciar.isError}
            errorMessage={iniciar.error?.message}
          />
        )}

        {phase.kind === "checkout" &&
          phase.step === "stripe" &&
          embeddedOptions && (
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: 4,
              }}
            >
              <EmbeddedCheckoutProvider
                stripe={getStripePromise()}
                options={embeddedOptions}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          )}

        {(phase.kind === "completed_pending" ||
          phase.kind === "completed_confirmed" ||
          phase.kind === "completed_slow") &&
          checkoutSnapshot && (
            <SuccessPanel
              phase={phase}
              snapshot={checkoutSnapshot}
              slug={slug}
              sessionId={sessionId}
              onClose={handleSuccessClose}
            />
          )}
      </aside>
    </>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────

function DrawerHeader({
  phase,
  canClose,
  onClose,
}: {
  phase: Phase;
  canClose: boolean;
  onClose?: () => void;
}) {
  const title =
    phase.kind === "summary"
      ? "Seu carrinho"
      : phase.kind === "checkout"
        ? "Finalizando compra"
        : phase.kind === "completed_confirmed"
          ? "Recebido com carinho ♡"
          : "Confirmando seu presente";

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "20px 24px",
        borderBottom: "1px solid var(--cream-2)",
        flexShrink: 0,
      }}
    >
      <h2
        id="cart-drawer-title"
        style={{
          margin: 0,
          fontSize: 22,
          color: "var(--plum)",
          fontWeight: 700,
          lineHeight: 1.15,
        }}
      >
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        disabled={!canClose}
        aria-label="Fechar carrinho"
        style={{
          width: 36,
          height: 36,
          borderRadius: 999,
          background: "var(--cream-2)",
          color: "var(--ink-soft)",
          border: "none",
          fontSize: 20,
          cursor: canClose ? "pointer" : "not-allowed",
          fontWeight: 700,
          lineHeight: 1,
          opacity: canClose ? 1 : 0.4,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </header>
  );
}

// ── Summary step ───────────────────────────────────────────────────────────

function SummaryStep({
  metodo,
  setMetodo,
  onFinalizar,
  isPending,
  isError,
  errorMessage,
}: {
  metodo: MetodoPagamento;
  setMetodo: (m: MetodoPagamento) => void;
  onFinalizar: () => void;
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
}) {
  const cart = useCart();
  const totalCents = metodo === "pix" ? cart.totalPixCents : cart.totalCartaoCents;

  if (cart.state.lines.length === 0) {
    return <EmptyCart />;
  }

  return (
    <>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "16px 24px 24px",
        }}
      >
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {cart.state.lines.map((line) => (
            <CartLineRow key={line.nome} line={line} />
          ))}
        </ul>
      </div>
      <footer
        style={{
          borderTop: "1px solid var(--cream-2)",
          padding: "20px 24px 24px",
          background: "var(--paper)",
          flexShrink: 0,
        }}
      >
        <MetodoPicker metodo={metodo} setMetodo={setMetodo} />

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginTop: 18,
            marginBottom: 14,
            paddingTop: 14,
            borderTop: "1px dashed var(--cream-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 20,
              color: "var(--ink-soft)",
            }}
          >
            Total {metodo === "pix" ? "no Pix" : "no cartão"}
          </span>
          <span
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 32,
              color: "var(--plum)",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatBRL(totalCents)}
          </span>
        </div>

        {isError && (
          <p
            role="alert"
            style={{
              margin: "0 0 12px",
              padding: "10px 12px",
              background: "var(--pink-soft)",
              borderRadius: 12,
              color: "var(--plum)",
              fontSize: 13,
              lineHeight: 1.4,
            }}
          >
            {errorMessage ?? "Algo deu errado — tenta de novo em alguns segundos."}
          </p>
        )}

        <button
          type="button"
          onClick={onFinalizar}
          disabled={isPending || cart.state.lines.length === 0}
          className="btn-lilac"
          style={{
            width: "100%",
            justifyContent: "center",
            opacity: isPending ? 0.7 : 1,
            cursor: isPending ? "wait" : "pointer",
          }}
        >
          {isPending ? "preparando..." : `Finalizar compra • ${formatBRL(totalCents)}`}
        </button>
        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 12,
            color: "var(--ink-mute)",
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          Pagamento seguro pelo Stripe ♡ Você completa nome + email + recadinho no
          próximo passo.
        </p>
      </footer>
    </>
  );
}

function EmptyCart() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        textAlign: "center",
      }}
    >
      <div
        aria-hidden
        style={{
          fontSize: 56,
          marginBottom: 18,
          opacity: 0.6,
        }}
      >
        🛒
      </div>
      <p
        style={{
          fontFamily: "var(--font-caveat), cursive",
          fontSize: 24,
          color: "var(--ink-soft)",
          margin: 0,
          lineHeight: 1.3,
        }}
      >
        seu carrinho está esperando ♡
      </p>
      <p
        style={{
          color: "var(--ink-mute)",
          fontSize: 14,
          marginTop: 10,
          maxWidth: 280,
        }}
      >
        Escolhe um presentinho da listinha pra começar.
      </p>
    </div>
  );
}

function CartLineRow({ line }: { line: CartLine }) {
  const cart = useCart();
  const lineTotalCents = line.valorCents * line.quantidade;

  return (
    <li
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr",
        gap: 14,
        padding: "14px 0",
        borderBottom: "1px solid var(--cream-2)",
        alignItems: "start",
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          borderRadius: 12,
          background: line.bgColor,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 28,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {line.imagemUrl ? (
          <img
            src={line.imagemUrl}
            alt={line.nome}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
          />
        ) : (
          <span aria-hidden>{line.emoji}</span>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              color: "var(--plum)",
              fontWeight: 600,
              lineHeight: 1.2,
              wordBreak: "break-word",
            }}
          >
            {line.nome}
          </h3>
          <button
            type="button"
            onClick={() => cart.remove(line.nome)}
            aria-label={`Remover ${line.nome} do carrinho`}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--ink-mute)",
              cursor: "pointer",
              fontSize: 13,
              padding: "2px 6px",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--coral-pink)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--ink-mute)";
            }}
          >
            remover
          </button>
        </div>
        <p
          style={{
            margin: "2px 0 8px",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-mute)",
          }}
        >
          {line.displayCategory}
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <QtyStepper line={line} />
          <span
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 22,
              color: "var(--plum)",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {formatBRL(lineTotalCents)}
          </span>
        </div>
      </div>
    </li>
  );
}

function QtyStepper({ line }: { line: CartLine }) {
  const cart = useCart();
  const canIncrement = line.quantidade < line.idsAvailable.length;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        border: "1px solid var(--cream-2)",
        borderRadius: 999,
        background: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <StepperBtn
        onClick={() => cart.decrement(line.nome)}
        aria-label={`Diminuir quantidade de ${line.nome}`}
      >
        −
      </StepperBtn>
      <span
        aria-live="polite"
        style={{
          minWidth: 28,
          textAlign: "center",
          fontFamily: "var(--font-patrick-hand), cursive",
          fontSize: 18,
          color: "var(--plum)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {line.quantidade}
      </span>
      <StepperBtn
        onClick={() => cart.increment(line.nome)}
        disabled={!canIncrement}
        aria-label={`Aumentar quantidade de ${line.nome}`}
      >
        +
      </StepperBtn>
    </div>
  );
}

function StepperBtn({
  children,
  onClick,
  disabled = false,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      style={{
        width: 30,
        height: 30,
        background: "transparent",
        border: "none",
        color: disabled ? "var(--ink-mute)" : "var(--plum)",
        fontSize: 18,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

function MetodoPicker({
  metodo,
  setMetodo,
}: {
  metodo: MetodoPagamento;
  setMetodo: (m: MetodoPagamento) => void;
}) {
  return (
    <fieldset
      style={{
        margin: 0,
        padding: 0,
        border: "none",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10,
      }}
    >
      <legend
        style={{
          fontSize: 12,
          color: "var(--ink-mute)",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 8,
          padding: 0,
        }}
      >
        Como você quer pagar?
      </legend>
      <MetodoOption
        active={metodo === "pix"}
        onSelect={() => setMetodo("pix")}
        emoji="💚"
        label="Pix"
        hint="sem taxa extra"
      />
      <MetodoOption
        active={metodo === "credit_card"}
        onSelect={() => setMetodo("credit_card")}
        emoji="💳"
        label="Cartão"
        hint="parcele em até 12x"
      />
    </fieldset>
  );
}

function MetodoOption({
  active,
  onSelect,
  emoji,
  label,
  hint,
}: {
  active: boolean;
  onSelect: () => void;
  emoji: string;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      style={{
        background: active ? "var(--lilac-soft)" : "var(--paper)",
        border: `1px solid ${active ? "var(--lilac-deep)" : "var(--cream-2)"}`,
        borderRadius: 14,
        padding: "12px 14px",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 0.18s ease",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <span
        style={{
          fontSize: 18,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span aria-hidden>{emoji}</span>
        <span style={{ color: "var(--plum)", fontWeight: 600, fontSize: 15 }}>
          {label}
        </span>
      </span>
      <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>{hint}</span>
    </button>
  );
}

// ── Success panel ──────────────────────────────────────────────────────────

function SuccessPanel({
  phase,
  snapshot,
  slug,
  sessionId,
  onClose,
}: {
  phase: Extract<
    Phase,
    { kind: "completed_pending" | "completed_confirmed" | "completed_slow" }
  >;
  snapshot: {
    lines: readonly CartLine[];
    totalUnits: number;
    totalCents: number;
  };
  slug: string;
  sessionId: string | null;
  onClose: () => void;
}) {
  const isConfirmed = phase.kind === "completed_confirmed";
  const isSlow = phase.kind === "completed_slow";

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "24px 24px 28px",
        textAlign: "center",
        overflowY: "auto",
      }}
    >
      <div
        aria-hidden
        style={{
          fontSize: 64,
          margin: "8px 0 18px",
          color: isConfirmed ? "var(--green)" : "var(--lilac-deep)",
        }}
      >
        {isConfirmed ? "✓" : isSlow ? "✿" : "♡"}
      </div>
      <h3
        style={{
          margin: "0 0 10px",
          fontSize: 24,
          color: "var(--plum)",
          fontWeight: 700,
          lineHeight: 1.2,
        }}
      >
        {isConfirmed
          ? "Compra confirmada ♡"
          : isSlow
            ? "Quase lá..."
            : "Recebemos seu pagamento"}
      </h3>
      <p
        style={{
          margin: "0 0 6px",
          fontFamily: "var(--font-caveat), cursive",
          fontSize: 20,
          color: "var(--ink-soft)",
        }}
      >
        {isConfirmed
          ? `${snapshot.totalUnits} presente${snapshot.totalUnits === 1 ? "" : "s"} a caminho do coração ♡`
          : isSlow
            ? "Ainda confirmando com o banco — pode levar 1-2 min."
            : "Confirmando com o banco..."}
      </p>
      <p
        style={{
          margin: "10px 0 22px",
          color: "var(--ink-mute)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Total: <strong style={{ color: "var(--plum)" }}>{formatBRL(snapshot.totalCents)}</strong>
      </p>

      <div
        style={{
          marginTop: 18,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          textAlign: "left",
          background: "var(--cream-2)",
          borderRadius: 14,
          padding: "14px 16px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--ink-mute)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          O que você comprou
        </span>
        <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {snapshot.lines.map((l) => (
            <li
              key={l.nome}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                fontSize: 13,
                color: "var(--ink-soft)",
              }}
            >
              <span>
                {l.nome}
                {l.quantidade > 1 && (
                  <span style={{ color: "var(--ink-mute)", marginLeft: 6 }}>
                    × {l.quantidade}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--plum)",
                }}
              >
                {formatBRL(l.valorCents * l.quantidade)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {isSlow && sessionId && (
        <p style={{ marginTop: 18, fontSize: 12, color: "var(--ink-mute)" }}>
          Se demorar muito,{" "}
          <a
            href={`/pagina/${encodeURIComponent(slug)}/sucesso?sessionId=${encodeURIComponent(sessionId)}`}
            style={{ color: "var(--plum)", textDecoration: "underline" }}
          >
            consulte o status aqui
          </a>
          .
        </p>
      )}

      <button
        type="button"
        onClick={onClose}
        className="btn-lilac"
        style={{
          marginTop: 24,
          width: "100%",
          justifyContent: "center",
        }}
      >
        Voltar pra listinha ♡
      </button>
    </div>
  );
}
