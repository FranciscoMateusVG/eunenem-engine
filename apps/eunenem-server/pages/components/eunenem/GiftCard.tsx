
import { useState } from "react";
import { useCart } from "@/lib/cart.js";
import { formatBRL } from "@/lib/formatBRL";
import type { VisitorGift } from "@/lib/visitorGift";

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
      onMouseEnter={() => !isTaken && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 24,
        padding: 18,
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
        {isTaken && (
          <span
            style={{
              position: "absolute",
              top: 14,
              right: 14,
              background: "var(--green)",
              color: "var(--plum)",
              padding: "4px 12px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              zIndex: 2,
            }}
          >
            ✓ Presenteado
          </span>
        )}
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
      </div>

      {/* aperture-nwxkq: wrap the middle content (name + price + qty tag) in a
          flex-grow container so the bottom CTA pins to the card bottom
          regardless of name-wrap or whether the "X de Y disponíveis" badge
          shows. Without this, cards in the same grid row have CTAs at
          inconsistent vertical positions. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <h3
          style={{
            fontSize: 24,
            color: "var(--plum)",
            marginTop: 16,
            marginBottom: 10,
            lineHeight: 1.1,
          }}
        >
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
          <span
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 30,
              color: "var(--plum)",
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            {formatBRL(gift.valorCents)}
          </span>
          <span
            style={{
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 18,
              color: "var(--coral-pink)",
            }}
          >
            presente
          </span>
        </div>

        {showQtyTag && (
          <p
            style={{
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 17,
              color: "var(--ink-soft)",
              marginBottom: 14,
              marginTop: 0,
              lineHeight: 1.2,
            }}
          >
            {gift.qtyAvailable > 0
              ? `${gift.qtyAvailable} de ${gift.qtyTotal} disponíveis ♡`
              : `todos os ${gift.qtyTotal} já foram ♡`}
          </p>
        )}
      </div>

      {isTaken ? (
        <button
          type="button"
          disabled
          style={{
            width: "100%",
            padding: "12px 18px",
            borderRadius: 999,
            background: "var(--cream-2)",
            color: "var(--ink-mute)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            cursor: "not-allowed",
            border: "none",
          }}
        >
          Já presenteado ♡
        </button>
      ) : inCartQty > 0 ? (
        <InCartStepper gift={gift} inCartQty={inCartQty} onPick={onPick} />
      ) : (
        <button
          type="button"
          onClick={() => onAdd(gift)}
          className="btn-lilac"
          style={{ width: "100%", justifyContent: "center" }}
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderRadius: 999,
          background: "var(--lilac-soft)",
          border: "1px solid var(--lilac-deep)",
        }}
      >
        <button
          type="button"
          onClick={() => cart.decrement(gift.nome)}
          aria-label={`Diminuir ${gift.nome}`}
          style={stepperBtnStyle(false)}
        >
          −
        </button>
        <span
          aria-live="polite"
          style={{
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 22,
            color: "var(--plum)",
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
          }}
        >
          {inCartQty} no carrinho
        </span>
        <button
          type="button"
          onClick={() => cart.increment(gift.nome)}
          disabled={!canIncrement}
          aria-label={`Aumentar ${gift.nome}`}
          style={stepperBtnStyle(!canIncrement)}
        >
          +
        </button>
      </div>
      <button
        type="button"
        onClick={() => onPick(gift)}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--ink-mute)",
          fontSize: 12,
          cursor: "pointer",
          padding: "4px 6px",
          alignSelf: "center",
        }}
      >
        ou comprar agora →
      </button>
    </div>
  );
}

function stepperBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    background: "var(--paper)",
    border: "1px solid var(--lilac-deep)",
    borderRadius: 999,
    color: disabled ? "var(--ink-mute)" : "var(--plum)",
    fontSize: 18,
    lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };
}
