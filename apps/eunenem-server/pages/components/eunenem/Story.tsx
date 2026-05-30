
import { FlowerDoodle, Polaroid, StarDoodle, Tape } from "./Doodles";
import { ImageSlot } from "./ImageSlot";
import { useTweaks } from "./TweaksContext";

// aperture-3d9t — Story section ("A nossa história").
//
// Two-column on desktop, stacked on mobile. Left: Caveat manuscript
// heading + 3 paragraphs of DM Sans body text + Caveat signature.
// Right: single polaroid (rotated -3deg) with tape decoration. Body
// copy is faithfully ported from the design reference and frames the
// parents' voice.
//
// aperture-uxjo4 — removed the yellow "previsto pra junho de 2026"
// post-it sticker per operator request. The launch-date callout was
// drifting (any operator override of targetDate left it stale) and
// the layout reads cleaner without it.

export function Story() {
  const { tweaks } = useTweaks();
  const { babyName, parents } = tweaks;

  return (
    <section className="eu-section" style={{ background: "var(--cream)" }}>
      <FlowerDoodle
        size={28}
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          top: 60,
          left: "8%",
          opacity: 0.35,
          ["--r" as string]: "-8deg",
        }}
      />
      <StarDoodle
        size={22}
        color="var(--coral-pink)"
        className="anim-twinkle"
        style={{
          position: "absolute",
          top: 100,
          right: "10%",
          opacity: 0.6,
        }}
      />

      <div
        className="eu-container"
        style={{ maxWidth: 1100 }}
      >
        <header style={{ textAlign: "center", marginBottom: 56 }}>
          <span className="eyebrow">a nossa história</span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            Como o{" "}
            <span style={{ color: "var(--coral-pink)" }}>{babyName}</span>{" "}
            chegou na <span className="hl">nossa vida</span>
          </h2>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-12 items-center">
          {/* Text */}
          <div>
            <div
              style={{
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 32,
                color: "var(--plum)",
                marginBottom: 16,
                transform: "rotate(-1.5deg)",
                display: "inline-block",
              }}
            >
              da primeira listrinha azul até hoje...
            </div>

            <p
              style={{
                color: "var(--ink-soft)",
                fontSize: 17,
                lineHeight: 1.7,
                maxWidth: 520,
              }}
            >
              A gente se conheceu numa tarde de quinta, em uma cafeteria
              minúscula no Pinheiros, sem fazer ideia de que sete anos
              depois estaríamos escolhendo o papel de parede do quartinho
              juntos. ♡
            </p>
            <p
              style={{
                color: "var(--ink-soft)",
                fontSize: 17,
                lineHeight: 1.7,
                maxWidth: 520,
                marginTop: 14,
              }}
            >
              O <strong style={{ color: "var(--ink)" }}>{babyName}</strong>{" "}
              começou a se anunciar em outubro, com um teste feito às
              pressas no banheiro de casa e um abraço daqueles que apertam
              até doer. Desde então é ele puxando a gente — escolhendo
              nomes, mandando soluço às 3 da manhã, virando o nosso
              planejamento de cabeça pra baixo (do melhor jeito possível).
            </p>
            <p
              style={{
                color: "var(--ink-soft)",
                fontSize: 17,
                lineHeight: 1.7,
                maxWidth: 520,
                marginTop: 14,
              }}
            >
              Esse chá é a nossa forma de te abraçar de volta.{" "}
              <strong style={{ color: "var(--ink)" }}>
                Cada presente vai direto pro cantinho dele
              </strong>{" "}
              — fralda, banho, berço, primeiras roupinhas — e o que sobrar
              vira poupança pro primeiro ano. Obrigada por estar aqui com a
              gente. ♡
            </p>

            <div
              style={{
                marginTop: 28,
                fontFamily: "var(--font-caveat), cursive",
                color: "var(--coral-pink)",
                fontSize: 28,
                transform: "rotate(-3deg)",
                display: "inline-block",
              }}
            >
              com amor, {parents}
            </div>
          </div>

          {/* Right — single polaroid + tape */}
          <div className="flex items-center justify-center py-5">
            <div className="relative inline-block">
              <Polaroid rotate={-3} caption="primeira ecografia ♡">
                <div
                  style={{
                    width: 280,
                    height: 320,
                    background: "var(--lilac-soft)",
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <ImageSlot
                    id="story-photo"
                    placeholder="Foto da família / ultrassom"
                    fit="cover"
                  />
                </div>
              </Polaroid>
              <Tape
                width={90}
                height={20}
                rotate={-6}
                style={{ top: -10, left: 80 }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
