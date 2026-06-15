import { useCart } from "@/lib/cart.js";

// Plan 0017 / aperture-16flf — Navbar cart trigger.
//
// Small icon button with a badge that surfaces the cart's total unit
// count. Click opens the CartDrawer. Hidden (display:none) when the
// cart is empty so the navbar reads cleanly on first-load — the moment
// the visitor adds an item the button slides in.
//
// Visual chassis: matches the Navbar's existing button vocabulary
// (lilac-deep stroke + paper bg + hover-lift). Badge sits top-right
// with a `coral-pink` fill to draw the eye without screaming. The pip
// fades-in on appear via `anim-cart-pop` (keyframes defined in
// tailwind.css alongside this bead's other UI).

interface CartButtonProps {
  onOpen: () => void;
}

export function CartButton({ onOpen }: CartButtonProps) {
  const { totalUnits } = useCart();
  if (totalUnits === 0) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Abrir carrinho — ${totalUnits} ${totalUnits === 1 ? "item" : "itens"}`}
      className="anim-cart-pop"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 44,
        height: 44,
        borderRadius: 999,
        background: "var(--paper)",
        border: "1px solid var(--lilac-soft)",
        color: "var(--plum)",
        cursor: "pointer",
        boxShadow: "var(--shadow-sm)",
        transition: "transform 0.2s ease, box-shadow 0.2s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "var(--shadow-md)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "var(--shadow-sm)";
      }}
    >
      <svg
        aria-hidden="true"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 7h14l-1.5 11a2 2 0 0 1-2 1.75H8.5A2 2 0 0 1 6.5 18L5 7Z" />
        <path d="M9 7V5a3 3 0 0 1 6 0v2" />
      </svg>
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: -4,
          right: -4,
          minWidth: 20,
          height: 20,
          padding: "0 6px",
          borderRadius: 999,
          background: "var(--coral-pink)",
          color: "var(--paper)",
          fontSize: 11,
          fontWeight: 700,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          letterSpacing: 0,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
        }}
      >
        {totalUnits}
      </span>
    </button>
  );
}
