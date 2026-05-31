
import { useState } from "react";
import { formatBRL } from "@/lib/formatBRL";
import type { VisitorGift } from "@/lib/visitorGift";

// aperture-3d9t (visual) + aperture-3xgch (data shape swap — VisitorGift).
//
// Renders one gift card on the public /pagina/<slug>. Now consumes the
// grouped-by-nome VisitorGift shape (see lib/visitorGift.ts). Real product
// image takes over the thumb when imagemUrl is set; otherwise we render the
// grupo-derived emoji on the colored square. CTA disabled when all units
// in the group are presenteado.
//
// Visual contract (unchanged from aperture-3d9t):
//   - Paper card, 24px radius, hover lifts 4px + bumps shadow
//   - Square thumb with emoji or image, category chip top-left
//   - "✓ Presenteado" badge top-right when status = presenteado
//   - Patrick Hand for the price, Caveat for the "presente" flourish
//   - btn-lilac CTA → "Presentear →", muted disabled CTA → "Já presenteado ♡"
//
// New affordance: when qtyTotal > 1, render a "X de Y disponíveis" tag
// below the price so the visitor knows there's more than one unit of this
// gift on the list.

interface GiftCardProps {
  gift: VisitorGift;
  onPick: (gift: VisitorGift) => void;
}

export function GiftCard({ gift, onPick }: GiftCardProps) {
  const [hover, setHover] = useState(false);
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
            zIndex: 2,
          }}
        >
          {gift.displayCategory}
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
              zIndex: 2,
            }}
          >
            ✓ Presenteado
          </span>
        )}
        {gift.imagemUrl ? (
          <img
            src={gift.imagemUrl}
            alt={gift.nome}
            loading="lazy"
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
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
