
import { useCallback, useMemo, useState } from "react";
import { BottleDoodle, FlowerDoodle } from "./Doodles";
import { GiftCard } from "./GiftCard";
import { GiftCheckoutModal } from "./GiftCheckoutModal";
import { useTweaks } from "./TweaksContext";
import { usePaginaListaPresentes } from "@/lib/paginaApi";
import {
  deriveCategoryChips,
  groupVisitorGifts,
  type VisitorGift,
} from "@/lib/visitorGift";

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
  const [activeCat, setActiveCat] = useState<string>("Todos");
  const [selectedGift, setSelectedGift] = useState<VisitorGift | null>(null);

  const gifts = useMemo(() => (data ? groupVisitorGifts(data) : []), [data]);
  const chips = useMemo(() => deriveCategoryChips(gifts), [gifts]);

  const filtered =
    activeCat === "Todos"
      ? gifts
      : gifts.filter((g) => g.grupoKey === activeCat);

  const onPick = useCallback((gift: VisitorGift) => {
    setSelectedGift(gift);
  }, []);

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

          {chips.length > 1 && (
            <div
              role="tablist"
              aria-label="Categorias de presentes"
              className="flex justify-center gap-2 flex-wrap mt-7 mb-2"
            >
              {chips.map((c) => {
                const active = activeCat === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveCat(c)}
                    style={{
                      padding: "9px 18px",
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--lilac-deep)" : "var(--line)"}`,
                      background: active
                        ? "var(--lilac-deep)"
                        : "var(--paper)",
                      color: active ? "#fff" : "var(--ink-soft)",
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: "pointer",
                      transition: "all 0.2s ease",
                      boxShadow: active ? "var(--shadow-cta)" : "none",
                    }}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
          )}
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
        ) : filtered.length === 0 ? (
          <p
            className="text-center mt-10"
            style={{
              color: "var(--ink-mute)",
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 22,
            }}
          >
            {gifts.length === 0
              ? `ainda não tem presentes aqui — volte daqui a pouco ♡`
              : "ainda não tem nada nessa categoria — escolhe outra ♡"}
          </p>
        ) : (
          <div className="grid gap-4 sm:gap-6 mt-12 grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
            {filtered.map((g) => (
              <GiftCard key={g.nome} gift={g} onPick={onPick} />
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
