
import {
  FlowerDoodle,
  HeartDoodle,
  Polaroid,
  StarDoodle,
  Tape,
} from "./Doodles";
import { ImageSlot } from "./ImageSlot";
import { CountdownTimer } from "./CountdownTimer";
import { useTweaks } from "./TweaksContext";
import { artigoPosse, saudacao } from "@/lib/concordancia";

// aperture-3d9t — Hero section.
//
// Two-column on desktop, stacked on mobile. Left: welcome eyebrow,
// big handwritten title with marca-texto on "chá de bebê" and the
// baby's name in coral-pink, countdown card, two CTAs. Right: cover
// photo (rotated 1.5deg + scrapbook tape) with a floating profile
// polaroid bottom-left.

// aperture-qjgfr gap-B — the creator's real cover (5:4) + profile (1:1)
// photos from getPerfilPublicoBySlug. Read-only on the guest page; null
// when the creator hasn't uploaded that slot (ImageSlot shows a neutral
// branded frame).
//
// aperture-3ic62 — `eventDate` is the creator's REAL event date (ISO
// YYYY-MM-DD) threaded explicitly from PaginaPage, or null when they
// never set one. We render the countdown ONLY when a real date exists.
// We deliberately do NOT read `tweaks.targetDate` for the gate: that
// field carries the shared TWEAKS_DEFAULTS demo date ("2026-06-15") as a
// fallback, which was leaking a fake "chegada em 0 dias" onto pages with
// no event date. The shared default is left untouched (the painel + its
// date math depend on it); the guest path just stops trusting it.
export function Hero({
  coverUrl = null,
  profileUrl = null,
  eventDate = null,
}: {
  coverUrl?: string | null;
  profileUrl?: string | null;
  eventDate?: string | null;
} = {}) {
  const { tweaks } = useTweaks();
  const { babyName, genero } = tweaks;
  const hasEventDate = typeof eventDate === "string" && eventDate.length > 0;

  return (
    <section className="relative overflow-hidden pt-4 pb-14 sm:pt-36 sm:pb-16">
      {/* Decorative doodles in the corners — hidden on mobile (aperture-wupjr).
          They use absolute top: 64 / 100 inside the section padding region, so
          shrinking the mobile padding-top would collide them with the badge
          and title. Desktop keeps the original sm:pt-36 padding and the doodles. */}
      <StarDoodle
        size={24}
        color="var(--yellow)"
        className="anim-twinkle hidden sm:block"
        style={{
          position: "absolute",
          top: 100,
          left: "44%",
        }}
      />
      <FlowerDoodle
        size={30}
        className="anim-doodle-sway hidden sm:block"
        style={{
          position: "absolute",
          top: 64,
          right: 80,
          ["--r" as string]: "10deg",
        }}
      />

      <div className="eu-container grid grid-cols-1 md:grid-cols-[1.1fr_1fr] items-center gap-14">
        {/* LEFT */}
        <div className="relative z-10">
          <div
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 mb-4"
            style={{
              background: "var(--lilac-soft)",
              color: "var(--lilac-deep)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            <span
              className="anim-live-pulse"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--lilac-deep)",
                display: "inline-block",
              }}
            />
            Chá de bebê online
          </div>

          <h1
            style={{
              fontSize: "clamp(40px, 5vw, 60px)",
              lineHeight: 1.0,
              marginBottom: 16,
            }}
          >
            {saudacao(genero)} ao <span className="hl">chá de bebê</span>
            <br />
            {artigoPosse(genero)} <span style={{ color: "var(--coral-pink)" }}>{babyName}</span>
            <span
              style={{
                display: "inline-block",
                marginLeft: 12,
                transform: "translateY(-4px) rotate(8deg)",
              }}
              aria-hidden="true"
            >
              <HeartDoodle size={30} color="var(--coral-pink)" />
            </span>
          </h1>

          {/* aperture-3ic62 — only render the countdown when the creator
              set a real event date. No date → no fake "chegada em 0 dias"
              card. The CTAs below remain so the page still reads as live. */}
          {hasEventDate && (
            <div className="flex gap-3 flex-wrap mb-5">
              <CountdownTimer targetISO={eventDate} />
            </div>
          )}

          <div className="flex gap-3 flex-wrap items-center">
            <a href="#presentes" className="btn-lilac no-underline">
              Quero presentear
              <span style={{ fontSize: 16, marginLeft: 4 }} aria-hidden="true">
                →
              </span>
            </a>
            <a href="#como" className="btn-outline no-underline">
              Como funciona
            </a>
          </div>
        </div>

        {/* RIGHT — cover photo + polaroid */}
        <div className="relative" style={{ minHeight: 360 }}>
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "5 / 4",
              borderRadius: 24,
              overflow: "hidden",
              boxShadow: "var(--shadow-lg)",
              transform: "rotate(1.5deg)",
            }}
          >
            <ImageSlot
              id="hero-cover"
              placeholder="Arraste a foto de capa aqui"
              fit="cover"
              src={coverUrl}
              readOnly
            />
            <Tape
              width={110}
              height={22}
              rotate={-4}
              style={{ top: -10, left: "20%" }}
            />
          </div>

          {/* Floating polaroid */}
          <div
            className="anim-float"
            style={{
              position: "absolute",
              bottom: -28,
              left: -24,
              zIndex: 3,
              transform: "rotate(-6deg)",
            }}
          >
            <Polaroid caption={`${babyName} ♡`}>
              <div
                style={{
                  width: 140,
                  height: 140,
                  borderRadius: 4,
                  overflow: "hidden",
                  background: "var(--cream-2)",
                }}
              >
                <ImageSlot
                  id="hero-profile"
                  placeholder="Foto do bebê"
                  fit="cover"
                  src={profileUrl}
                  readOnly
                />
              </div>
            </Polaroid>
          </div>
        </div>
      </div>
    </section>
  );
}
