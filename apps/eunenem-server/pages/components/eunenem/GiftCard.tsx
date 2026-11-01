
import { useState } from "react";
import { useCart } from "@/lib/cart.js";
import { formatBRL } from "@/lib/formatBRL";
import type { VisitorGift } from "@/lib/visitorGift";
import { OwnerGiftActions } from "./PaginaOwnerGiftEditor";

// aperture-3d9t (visual) + aperture-3xgch (data shape swap — VisitorGift)
// + aperture-16flf (visitor-cart MVP — replace direct PRESENTEAR CTA with
//   "+ Adicionar" → in-cart QtyStepper).
//
// Renders one gift card on the public /pagina/<slug>. Reads the cart for
// the per-gift qty + remaining-available count, so once an item is in the
// cart the CTA flips to a +/- stepper inline on the card.
//
// Plan 0017 CTA states (operator's verbal spec: cart is primary, single-
// shot is the fallback):
//   - In stock + NOT in cart → "+ Adicionar" lilac CTA (adds 1, opens drawer)
//   - In stock + already in cart → inline QtyStepper "- / N / +"
//     accompanied by a small "comprar agora →" link below for single-shot
//   - All units presenteado → muted disabled chip "Já presenteado ♡"
//
// onPick is preserved as the single-shot fallback path (GiftCheckoutModal).
// Plus a new onAdd callback that the Marketplace wires up to open the drawer.

interface GiftCardProps {
  gift: VisitorGift;
  onPick: (gift: VisitorGift) => void;
  onAdd: (gift: VisitorGift) => void;
}

export function GiftCard({ gift, onPick, onAdd }: GiftCardProps) {
  const [hover, setHover] = useState(false);
  const cart = useCart();
  const inCartQty = cart.quantidadeFor(gift.nome);
  const isTaken = gift.status === "presenteado";
  const showQtyTag = gift.qtyTotal > 1;

  return (
    <article
      data-testid="pagina-gift-item"
      data-gift-nome={gift.nome}
      onMouseEnter={() => !isTaken && setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pagina-gift-card"
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        boxShadow: hover ? "var(--shadow-md)" : "var(--shadow-sm)",
        display: "flex",
        flexDirection: "column",
        transition: "transform 0.25s ease, box-shadow 0.25s ease",
        transform: hover ? "translateY(-4px)" : "translateY(0)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          borderRadius: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 70,
          position: "relative",
          overflow: "hidden",
          background: gift.bgColor,
        }}
      >
        {isTaken && <span className="pagina-gift-tag">✓ Presenteado</span>}
        {gift.imagemUrl ? (
          // aperture-actmy: pin the image to fill the thumb and carry the
          // SAME border-radius as its container. Safari/Firefox anti-alias
          // the rounded overflow:hidden clip and leave a sub-pixel sliver of
          // the parent bgColor (often a pink token) peeking at the top edge —
          // the intermittent pink/rose hairline. Letting the <img> own a
          // matching radius means the clipped edge is the image's own pixels,
          // so there's no parent fill behind the AA seam to bleed through.
          <img
            src={gift.imagemUrl}
            alt={gift.nome}
            loading="lazy"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: 18,
              filter: isTaken ? "grayscale(0.4) opacity(.55)" : "none",
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              filter: isTaken ? "grayscale(0.4) opacity(.55)" : "none",
            }}
          >
            {gift.emoji}
          </span>
        )}
        <OwnerGiftActions gift={gift} />
      </div>

      {/* aperture-nwxkq: wrap the middle content (name + price + qty tag) in a
          flex-grow container so the bottom CTA pins to the card bottom
          regardless of name-wrap or whether the "X de Y disponíveis" badge
          shows. Without this, cards in the same grid row have CTAs at
          inconsistent vertical positions. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* aperture-w7v66: clamped to 3 lines; title keeps the full name. */}
        <h3 className="pagina-gift-nome" title={gift.nome}>
          {gift.nome}
        </h3>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: showQtyTag ? 8 : 16,
          }}
        >
          <span className="pagina-gift-preco">{formatBRL(gift.valorCents)}</span>
          {/* aperture-w7v66: decorative label, hidden below sm. */}
          <span className="pagina-gift-preco-rotulo">presente</span>
        </div>

        {showQtyTag && (
          <p className="pagina-gift-disponiveis">
            {gift.qtyAvailable > 0
              ? `${gift.qtyAvailable} de ${gift.qtyTotal} disponíveis ♡`
              : `todos os ${gift.qtyTotal} já foram ♡`}
          </p>
        )}
      </div>

      {isTaken ? (
        <button type="button" disabled className="pagina-gift-cta pagina-gift-cta-presenteado">
          <span className="pagina-gift-cta-ja">Já </span>presenteado ♡
        </button>
      ) : inCartQty > 0 ? (
        <InCartStepper gift={gift} inCartQty={inCartQty} onPick={onPick} />
      ) : (
        <button
          type="button"
          onClick={() => onAdd(gift)}
          className="btn-lilac pagina-gift-cta"
        >
          + Adicionar
        </button>
      )}
    </article>
  );
}

// Inline stepper that replaces the CTA once the gift is in the cart. Mirrors
// the drawer's stepper vocabulary so the visitor's mental model carries
// across both surfaces. Decrement at quantidade=1 removes the line entirely
// (the natural UX read: dragging the count below 1 means "I don't want
// this anymore"). Increment caps at the group's available unit count.
function InCartStepper({
  gift,
  inCartQty,
  onPick,
}: {
  gift: VisitorGift;
  inCartQty: number;
  onPick: (gift: VisitorGift) => void;
}) {
  const cart = useCart();
  const canIncrement = inCartQty < gift.qtyAvailable;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="pagina-gift-stepper">
        <button
          type="button"
          onClick={() => cart.decrement(gift.nome, "card")}
          aria-label={`Diminuir ${gift.nome}`}
          className="pagina-gift-stepper-btn"
          style={stepperBtnStyle(false)}
        >
          −
        </button>
        <span aria-live="polite" className="pagina-gift-stepper-qtd">
          {inCartQty}
          <span className="pagina-gift-stepper-sufixo"> no carrinho</span>
        </span>
        <button
          type="button"
          onClick={() => cart.increment(gift.nome, "card")}
          disabled={!canIncrement}
          aria-label={`Aumentar ${gift.nome}`}
          className="pagina-gift-stepper-btn"
          style={stepperBtnStyle(!canIncrement)}
        >
          +
        </button>
      </div>
      <button
        type="button"
        onClick={() => onPick(gift)}
        className="pagina-gift-comprar-agora"
      >
        ou comprar agora →
      </button>
    </div>
  );
}

function stepperBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: "var(--paper)",
    border: "1px solid var(--lilac-deep)",
    borderRadius: 999,
    color: disabled ? "var(--ink-mute)" : "var(--plum)",
    lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}
