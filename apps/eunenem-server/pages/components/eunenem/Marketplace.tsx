
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artigoPosse } from "@/lib/concordancia";
import { BottleDoodle, FlowerDoodle } from "./Doodles";
import { GiftCard } from "./GiftCard";
import { GiftCheckoutModal } from "./GiftCheckoutModal";
import { useCart } from "@/lib/cart.js";
import { useCartDrawer } from "./CartDrawerContext.js";
import { emitirCarrinhoAberto } from "@/lib/analytics-funil";
import { useTweaks } from "./TweaksContext";
import { OWNER_EDIT_LISTA_LABEL } from "@/lib/pagina-owner";
import { usePaginaListaPresentes } from "@/lib/paginaApi";
import { formatBRL } from "@/lib/formatBRL";
import { filterVisitorGifts, type GiftSort } from "@/lib/visitorGiftFilters";
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
  /**
   * aperture-4e1qo — owner shortcut to the painel editor of THIS campanha.
   * PaginaPage computes it from the server-resolved projection
   * (ownerListaEditHref: isOwner === true + idCampanha + creator slug →
   * /painel/:slug/c/:idCampanha/lista) and passes null for everyone else, so
   * guests / signed-out / other owners never get the element in the tree.
   */
  ownerEditHref?: string | null;
}

/**
 * aperture-4e1qo — native link (no modal, no JS routing) so it works with
 * SSR, keyboard and middle-click. 44px floor for touch; pencil is decorative.
 */
export function OwnerEditListaLink({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={href}
      className={`btn-outline no-underline eu-owner-edit-lista${className ? ` ${className}` : ""}`}
      data-testid="owner-edit-lista"
      style={{ minHeight: 44 }}
    >
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
        <path d="M13.5 6.5l3 3" />
      </svg>
      {OWNER_EDIT_LISTA_LABEL}
    </a>
  );
}

export function Marketplace({ slug, ownerEditHref = null }: MarketplaceProps) {
  const { tweaks } = useTweaks();
  const { data, isLoading, isError } = usePaginaListaPresentes(slug);
  const [selectedGift, setSelectedGift] = useState<VisitorGift | null>(null);

  const gifts = useMemo(() => (data ? groupVisitorGifts(data) : []), [data]);

  const [search, setSearch] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState<GiftSort>("default");
  const sortMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    // Close on an actual outside press, not blur: Safari can report a null
    // relatedTarget when a menu option is pressed, before its click fires.
    const closeOutside = (event: PointerEvent) => {
      const menu = sortMenuRef.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const priceCeiling = Math.max(1, ...gifts.map((gift) => gift.valorCents));
  const selectedPrice = maxPrice === "" ? priceCeiling : Math.min(Math.round(Number(maxPrice) * 100), priceCeiling);
  const visibleGifts = useMemo(
    () => filterVisitorGifts(gifts, { search, minPrice: "", maxPrice, sort }),
    [gifts, search, maxPrice, sort],
  );
  const resetFilters = () => {
    setSearch("");
    setMaxPrice("");
    setSort("default");
  };
  const controlStyle = {
    width: "100%", minWidth: 0, minHeight: 44, padding: "10px 14px",
    borderRadius: 16, border: "1px solid var(--line)",
    background: "var(--paper)", color: "var(--ink)", fontSize: 16,
  };

  const cart = useCart();
  const drawer = useCartDrawer();

  // aperture-v6mpf — report the single-gift checkout modal's visibility so
  // PaginaPage can hide the floating TweaksPanel behind purchase overlays
  // (the drawer already reports itself via isOpen).
  const { setCheckoutModalOpen } = drawer;
  useEffect(() => {
    setCheckoutModalOpen(selectedGift !== null);
    return () => setCheckoutModalOpen(false);
  }, [selectedGift, setCheckoutModalOpen]);

  const onPick = useCallback((gift: VisitorGift) => {
    setSelectedGift(gift);
  }, []);

  const onAdd = useCallback(
    (gift: VisitorGift) => {
      cart.add(gift, "card");
      // aperture-qq74p — only a real closed→open transition is an event.
      emitirCarrinhoAberto(drawer.isOpen, "adicionar");
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
            a listinha {artigoPosse(tweaks.genero)} {tweaks.babyName}
          </span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            Escolha um <span className="hl">presentinho</span> ♡
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
            Cada presente vira dinheiro direto na conta dos papais — sem
            caixinha de loja, sem mensalidade. Você paga com Pix ou
            cartão, em checkout seguro.
          </p>
          {ownerEditHref && (
            <div style={{ marginTop: 18, display: "flex", justifyContent: "center" }}>
              <OwnerEditListaLink href={ownerEditHref} />
            </div>
          )}
        </header>

        {!isLoading && !isError && gifts.length > 0 && (
          <div role="search" aria-label="Filtrar presentes" style={{ marginTop: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                <svg aria-hidden="true" viewBox="0 0 24 24" width={20} height={20}
                  fill="none" stroke="currentColor" strokeWidth={1.8}
                  style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--ink-soft)", pointerEvents: "none" }}>
                  <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" />
                </svg>
                <input aria-label="Buscar presente" type="search" value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar presente" style={{ ...controlStyle, paddingLeft: 44 }} />
              </div>
              <details ref={sortMenuRef} style={{ position: "relative", flexShrink: 0 }}
                onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}
                onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
                <summary aria-label="Ordenar presentes" title="Ordenar presentes"
                  className="gift-sort-trigger"
                  style={{ ...controlStyle, width: 44, height: 44, padding: 10, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", listStyle: "none" }}>
                  <svg aria-hidden="true" viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 4v16m-4-4 4 4 4-4M14 5h6m-6 5h4m-4 5h2" />
                  </svg>
                </summary>
                <div role="group" aria-label="Ordenar por"
                  style={{ position: "absolute", right: 0, top: 52, width: 240, zIndex: 10, padding: 6, borderRadius: 16, background: "var(--paper)", border: "1px solid var(--line)", boxShadow: "var(--shadow-sm)" }}>
                  {([
                    ["default", "Ordem da lista"],
                    ["name", "Ordem alfabética (A–Z)"],
                    ["price-asc", "Menor para o maior preço"],
                    ["price-desc", "Maior para o menor preço"],
                  ] as const).map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={sort === value}
                      onClick={(event) => {
                        setSort(value);
                        const details = event.currentTarget.closest("details");
                        if (details) { details.open = false; details.querySelector("summary")?.focus(); }
                      }}
                      style={{ display: "block", width: "100%", textAlign: "left", minHeight: 44, padding: "10px 12px", border: 0, borderRadius: 10, cursor: "pointer", color: "var(--ink)", background: sort === value ? "var(--lilac-soft)" : "transparent", fontSize: 14 }}>
                      {label}
                    </button>
                  ))}
                </div>
              </details>
            </div>
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, color: "var(--ink-soft)", fontSize: 14 }}>
                <label htmlFor="gift-price-limit">Preço até</label>
                <output htmlFor="gift-price-limit" style={{ fontWeight: 600 }}>{formatBRL(selectedPrice)}</output>
              </div>
              <input id="gift-price-limit" aria-label="Preço máximo do presente" type="range"
                min={0} max={priceCeiling} step={1} value={selectedPrice}
                aria-valuetext={formatBRL(selectedPrice)} className="calculadora-slider"
                style={{ width: "100%", ["--pct" as string]: `${selectedPrice / priceCeiling * 100}%` }}
                onChange={(event) => setMaxPrice(Number(event.target.value) === priceCeiling ? "" : (Number(event.target.value) / 100).toFixed(2))} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 12 }}>
              <p role="status" style={{ color: "var(--ink-soft)", margin: 0 }}>
                {visibleGifts.length} de {gifts.length} presentes
              </p>
              {(search || maxPrice || sort !== "default") && (
                <button type="button" className="btn-outline" onClick={resetFilters}>Limpar filtros</button>
              )}
            </div>
          </div>
        )}

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
          // aperture-4e1qo — the owner's "Editar lista de presentes" CTA lives
          // in the header above, which stays rendered in this empty state, so
          // no second CTA here (root: one CTA that persists in empty suffices).
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
        ) : visibleGifts.length === 0 ? (
          <p className="text-center mt-10" style={{ color: "var(--ink-soft)" }}>
            Nenhum presente encontrado. Tente outro nome ou faixa de preço ♡
          </p>
        ) : (
          <div className="grid gap-4 sm:gap-6 mt-12 grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
            {visibleGifts.map((g) => (
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
