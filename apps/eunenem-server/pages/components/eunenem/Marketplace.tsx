
import { useCallback, useMemo, useState } from "react";
import { BottleDoodle, FlowerDoodle } from "./Doodles";
import { GiftCard } from "./GiftCard";
import { GiftCheckoutModal } from "./GiftCheckoutModal";
import { useCart } from "@/lib/cart.js";
import { useCartDrawer } from "./CartDrawerContext.js";
import { useTweaks } from "./TweaksContext";
import { usePaginaListaPresentes } from "@/lib/paginaApi";
import { groupVisitorGifts, type VisitorGift } from "@/lib/visitorGift";

// aperture-3d9t (original visual scaffold) + aperture-3xgch (data swap).
//
// Real contribuicoes from postgres replace the GIFTS mock. The mock-era
// "1-second Pix delay + mural insert + toast" closure is gone — Stripe
// Embedded Checkout handles the payment, and the mural update happens
// server-side via the webhook (see aperture-24n36) so it's the single
// source of truth for any visitor across the world.
//
// Slug threads down from PaginaPage → Marketplace → GiftCheckoutModal so
// the mutation can resolve the campanha server-side.
//
// Loading + empty states mirror the EuNeném tone — handwritten Caveat
// copy, no spinner-on-grey-card business.

interface MarketplaceProps {
  slug: string;
}

export function Marketplace({ slug }: MarketplaceProps) {
  const { tweaks } = useTweaks();
  const { data, isLoading, isError } = usePaginaListaPresentes(slug);
  const [selectedGift, setSelectedGift] = useState<VisitorGift | null>(null);

  const gifts = useMemo(() => (data ? groupVisitorGifts(data) : []), [data]);

  const cart = useCart();
  const drawer = useCartDrawer();

  const onPick = useCallback((gift: VisitorGift) => {
    setSelectedGift(gift);
  }, []);

  const onAdd = useCallback(
    (gift: VisitorGift) => {
      cart.add(gift);
      drawer.open();
    },
    [cart, drawer],
  );

  return (
    <section
      id="presentes"
      className="eu-section"
      style={{ background: "var(--cream-2)" }}
    >
      <BottleDoodle
        size={24}
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          top: 80,
          left: "6%",
          opacity: 0.3,
          ["--r" as string]: "-12deg",
        }}
      />
      <FlowerDoodle
        size={24}
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          top: 120,
          right: "6%",
          opacity: 0.3,
          ["--r" as string]: "8deg",
        }}
      />

      <div className="eu-container">
        <header style={{ textAlign: "center", marginBottom: 32 }}>
          <span className="eyebrow eyebrow-coral">
            a listinha do {tweaks.babyName}
          </span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            Escolhe um <span className="hl">presentinho</span> ♡
          </h2>
          <p
            style={{
              color: "var(--ink-soft)",
              fontSize: 17,
              marginTop: 12,
              maxWidth: 540,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Cada presente vira dinheiro direto no Pix dos papais — sem
            caixinha de loja, sem mensalidade. Você paga com Pix ou
            cartão, em checkout seguro.
          </p>
        </header>

        {/* aperture-rdr8u — Mobile renders 2 columns (was 1) because the
            inline auto-fill minmax(260px, 1fr) couldn't fit 2 columns under
            ~544px viewport. From sm: up we restore the original auto-fill
            behavior so tablet (sm: 2-3 cols) and desktop (lg: 3-4 cols) stay
            unchanged. Mobile gap tightens to gap-4 to give half-width cards
            more breathing room. */}
        {isLoading ? (
          <MarketplaceSkeleton />
        ) : isError ? (
          <p
            className="text-center mt-10"
            style={{
              color: "var(--ink-mute)",
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 22,
            }}
          >
            ainda não consegui carregar a listinha — recarrega a página ♡
          </p>
        ) : gifts.length === 0 ? (
          <p
            className="text-center mt-10"
            style={{
              color: "var(--ink-mute)",
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 22,
            }}
          >
            ainda não tem presentes aqui — volte daqui a pouco ♡
          </p>
        ) : (
          <div className="grid gap-4 sm:gap-6 mt-12 grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
            {gifts.map((g) => (
              <GiftCard key={g.nome} gift={g} onPick={onPick} onAdd={onAdd} />
            ))}
          </div>
        )}
      </div>

      {selectedGift && (
        <GiftCheckoutModal
          gift={selectedGift}
          babyName={tweaks.babyName}
          slug={slug}
          onClose={() => setSelectedGift(null)}
        />
      )}
    </section>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────
// Six placeholder cards — same grid + radius + paper as real cards so the
// layout doesn't jump. Animated lilac shimmer pulled in via CSS class
// `anim-skeleton-pulse` (added to tailwind.css alongside this bead).

function MarketplaceSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-4 sm:gap-6 mt-12 grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <article
          key={i}
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: 24,
            padding: 18,
            boxShadow: "var(--shadow-sm)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="anim-skeleton-pulse"
            style={{
              width: "100%",
              aspectRatio: "1 / 1",
              borderRadius: 18,
              background: "var(--cream-2)",
            }}
          />
          <div
            className="anim-skeleton-pulse"
            style={{
              height: 22,
              width: "70%",
              borderRadius: 8,
              background: "var(--cream-2)",
              marginTop: 16,
            }}
          />
          <div
            className="anim-skeleton-pulse"
            style={{
              height: 30,
              width: "40%",
              borderRadius: 8,
              background: "var(--cream-2)",
              marginTop: 16,
            }}
          />
          <div
            style={{
              height: 44,
              width: "100%",
              borderRadius: 999,
              background: "var(--cream-2)",
              marginTop: 16,
            }}
            className="anim-skeleton-pulse"
          />
        </article>
      ))}
    </div>
  );
}
