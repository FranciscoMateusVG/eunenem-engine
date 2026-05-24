
import { useState } from "react";
import type { Gift } from "@/lib/mocks/gifts";

// aperture-3d9t — single gift card.
//
// Renders a paper card with: emoji-icon thumb (colored bg) + category
// badge + name + description + price + CTA. Hover lifts the card 4px
// + bumps the shadow.
//
// CTA states:
//   - 'available' → "Presentear →" (primary lilac CTA)
//   - 'presenteado' → "Já presenteado ♡" (disabled, muted)
//
// All visual decisions are inline-style on purpose — match the
// design's pixel-level rotations, gradients, and shadow values.

interface GiftCardProps {
  gift: Gift;
  onPick: (gift: Gift) => void;
}

export function GiftCard({ gift, onPick }: GiftCardProps) {
  const [hover, setHover] = useState(false);
  const isTaken = gift.status === "presenteado";

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
        <span
          style={{
            position: "absolute",
            top: 14,
            left: 14,
            background: "rgba(255, 255, 255, 0.85)",
            backdropFilter: "blur(6px)",
            padding: "4px 12px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-soft)",
          }}
        >
          {gift.category}
        </span>
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
            }}
          >
            ✓ Presenteado
          </span>
        )}
        <span
          aria-hidden="true"
          style={{
            filter: isTaken ? "grayscale(0.4) opacity(.55)" : "none",
          }}
        >
          {gift.emoji}
        </span>
      </div>

      <h3
        style={{
          fontSize: 24,
          color: "var(--plum)",
          marginTop: 16,
          marginBottom: 6,
          lineHeight: 1.1,
        }}
      >
        {gift.name}
      </h3>
      <p
        style={{
          fontSize: 14,
          color: "var(--ink-soft)",
          lineHeight: 1.4,
          marginBottom: 16,
          minHeight: 38,
        }}
      >
        {gift.description}
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 16,
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
          R$ {gift.priceBRL}
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

      <button
        type="button"
        onClick={() => !isTaken && onPick(gift)}
        disabled={isTaken}
        className={isTaken ? "" : "btn-lilac"}
        style={
          isTaken
            ? {
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
              }
            : { width: "100%", justifyContent: "center" }
        }
      >
        {isTaken ? "Já presenteado ♡" : "Presentear →"}
      </button>
    </article>
  );
}
