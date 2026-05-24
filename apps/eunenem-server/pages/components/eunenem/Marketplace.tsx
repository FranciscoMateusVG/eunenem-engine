
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { BottleDoodle, FlowerDoodle } from "./Doodles";
import { GiftCard } from "./GiftCard";
import { GiftCheckoutModal } from "./GiftCheckoutModal";
import { useTweaks } from "./TweaksContext";
import { GIFT_CATEGORIES, GIFTS, type Gift } from "@/lib/mocks/gifts";
import { useMural } from "./MuralContext";

// aperture-3d9t — Marketplace section ("Escolhe um presentinho ♡").
//
// Category chip filter + responsive gift grid. State managed locally:
// - active category filter
// - gift "presenteado" status (clicking PRESENTEAR flips a gift to
//   presenteado after the modal flow)
// - checkout modal selection
//
// On successful PRESENTEAR:
// 1. Modal closes
// 2. Sonner toast: "Presente registrado! Obrigado ♡"
// 3. Gift card flips to "JÁ PRESENTEADO ♡"
// 4. New mural message added with the contributor's note (author "Você")

export function Marketplace() {
  const { tweaks } = useTweaks();
  const { addMessage } = useMural();
  const [gifts, setGifts] = useState<Gift[]>(GIFTS);
  const [activeCat, setActiveCat] = useState<string>("Todos");
  const [selectedGift, setSelectedGift] = useState<Gift | null>(null);

  const filtered =
    activeCat === "Todos"
      ? gifts
      : gifts.filter((g) => g.category === activeCat);

  const onPick = useCallback((gift: Gift) => {
    setSelectedGift(gift);
  }, []);

  const onConfirm = useCallback(
    async (note: string) => {
      if (!selectedGift) return;
      // Simulated 1-second checkout delay — see Step 8 of the build plan.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      setGifts((prev) =>
        prev.map((g) =>
          g.id === selectedGift.id ? { ...g, status: "presenteado" } : g,
        ),
      );

      // Add a mural message with the contributor's note (mock author "Você").
      addMessage({
        authorName: "Você",
        avatarBg: "var(--lilac-deep)",
        avatarInitials: "VC",
        timeAgo: "agora há pouco",
        message:
          note.trim() ||
          `Mandando um abraço apertado pro ${tweaks.babyName} ♡`,
        style: "caveat",
        rotation: -1,
      });

      toast.success("Presente registrado! Obrigado ♡", {
        description: `${selectedGift.name} — recadinho enviado pro mural do ${tweaks.babyName}.`,
        duration: 4500,
      });
      setSelectedGift(null);
    },
    [selectedGift, addMessage, tweaks.babyName],
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

          {/* Category chips */}
          <div
            role="tablist"
            aria-label="Categorias de presentes"
            className="flex justify-center gap-2 flex-wrap mt-7 mb-2"
          >
            {GIFT_CATEGORIES.map((c) => {
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
        </header>

        <div
          className="grid gap-6 mt-12"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          }}
        >
          {filtered.map((g) => (
            <GiftCard key={g.id} gift={g} onPick={onPick} />
          ))}
        </div>

        {filtered.length === 0 && (
          <p
            className="text-center mt-10"
            style={{
              color: "var(--ink-mute)",
              fontFamily: "var(--font-caveat), cursive",
              fontSize: 22,
            }}
          >
            ainda não tem nada nessa categoria — escolhe outra ♡
          </p>
        )}
      </div>

      {selectedGift && (
        <GiftCheckoutModal
          gift={selectedGift}
          babyName={tweaks.babyName}
          onClose={() => setSelectedGift(null)}
          onConfirm={onConfirm}
        />
      )}
    </section>
  );
}
