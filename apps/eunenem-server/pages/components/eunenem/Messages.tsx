
import { useState } from "react";
import { type PaginaMuralRecado, usePaginaMural } from "@/lib/paginaApi";
import { FlowerDoodle, HeartDoodle, Tape } from "./Doodles";
import { useTweaks } from "./TweaksContext";

// aperture-3d9t — Mural section ("o mural do <baby>").
// aperture-7eci9 — mocks → real recados from aprovado pagamentos with
// a non-empty mensagem. Also drops the free-form "Só deixar recado"
// composer + the misleading "seu recadinho aqui" CTA — recados are
// bound to pagamentos (custom_fields on Stripe checkout) and there is
// no free-form recado path. The remaining "Escolher presente" CTA
// lives inside MarketplaceCTA elsewhere; this section is now
// read-only.
//
// Each card preserves the existing scrapbook styling:
// - rotated -3 to 3 degrees (deterministic per pagamento id)
// - scrapbook tape on top edge
// - avatar circle with initials + colored bg
// - name + relative-time metadata
// - message body in Caveat (italic + quotes)
// - hover lifts the card and straightens its rotation
//
// Empty state: when no aprovados-with-mensagem exist, show a single
// invitation card prompting visitors to pick a presente (no free-form
// recado path).

interface MessagesProps {
  slug: string;
}

export function Messages({ slug }: MessagesProps) {
  const { tweaks } = useTweaks();
  const { data, isLoading } = usePaginaMural(slug);
  const recados = data ?? [];

  return (
    <section
      id="mural"
      className="eu-section relative overflow-hidden"
      style={{ background: "var(--cream-2)" }}
    >
      <FlowerDoodle
        size={26}
        className="anim-doodle-sway"
        style={{
          position: "absolute",
          top: 80,
          left: "6%",
          opacity: 0.35,
          ["--r" as string]: "-6deg",
        }}
      />
      <HeartDoodle
        size={18}
        color="var(--lilac-deep)"
        style={{
          position: "absolute",
          top: 120,
          right: "8%",
          opacity: 0.5,
          transform: "rotate(10deg)",
        }}
      />

      <div className="eu-container">
        <header style={{ textAlign: "center", marginBottom: 48 }}>
          <span className="eyebrow eyebrow-coral">com carinho ♡</span>
          <h2
            style={{
              fontSize: "clamp(36px, 4.4vw, 52px)",
              marginTop: 8,
            }}
          >
            o mural do{" "}
            <span style={{ color: "var(--coral-pink)" }}>
              {tweaks.babyName}
            </span>
          </h2>
          <p
            style={{
              color: "var(--ink-soft)",
              fontSize: 16,
              marginTop: 12,
              maxWidth: 540,
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            Cada presente vem com um recadinho pro {tweaks.babyName} já se
            acostumar com a voz de vocês. ♡
          </p>
        </header>

        {isLoading ? (
          <MuralSkeleton />
        ) : recados.length === 0 ? (
          <EmptyMural babyName={tweaks.babyName} />
        ) : (
          <div
            className="grid gap-7"
            style={{
              gridTemplateColumns:
                "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {recados.map((r) => (
              <MessageCard key={r.id} recado={r} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function MessageCard({ recado }: { recado: PaginaMuralRecado }) {
  const [hover, setHover] = useState(false);
  // Deterministic rotation + avatar color per pagamento id so the same
  // recado renders identically on every reload (the data has no rotation
  // / avatarBg column — we derive both from the opaque id).
  const seed = hashSeed(recado.id);
  const rotation = ((seed % 60) - 30) / 10; // -3.0 .. 3.0 degrees
  const avatarBg = AVATAR_PALETTE[seed % AVATAR_PALETTE.length] ?? "var(--lilac-deep)";
  const initials = computeInitials(recado.contribuinteNome);
  const timeAgo = formatRelativeTime(new Date(recado.criadoEm), new Date());

  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 18,
        padding: "22px 22px 18px",
        boxShadow: "var(--shadow-md)",
        position: "relative",
        transition: "transform 0.25s ease",
        transform: hover
          ? "rotate(0deg) translateY(-4px)"
          : `rotate(${rotation}deg)`,
      }}
    >
      <Tape
        width={70}
        height={18}
        rotate={-2}
        style={{
          top: -10,
          left: "50%",
          marginLeft: -35,
        }}
      />

      <div className="flex items-center gap-3 mb-3">
        <span
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "2.5px solid #fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 22,
            boxShadow: "var(--shadow-sm)",
            background: avatarBg,
            flexShrink: 0,
          }}
        >
          {initials}
        </span>
        <div>
          <div
            style={{
              fontWeight: 700,
              color: "var(--ink)",
              fontSize: 15,
              lineHeight: 1.1,
            }}
          >
            {recado.contribuinteNome}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-mute)" }}>
            {timeAgo}
          </div>
        </div>
      </div>

      <div
        style={{
          fontFamily: "var(--font-caveat), cursive",
          fontSize: 24,
          color: "var(--ink)",
          lineHeight: 1.25,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        “{recado.mensagem}”
      </div>
    </article>
  );
}

function EmptyMural({ babyName }: { babyName: string }) {
  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1.5px dashed var(--lilac)",
        borderRadius: 18,
        padding: 32,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        maxWidth: 420,
        marginLeft: "auto",
        marginRight: "auto",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-patrick-hand), cursive",
          fontSize: 24,
          color: "var(--plum)",
          marginBottom: 8,
        }}
      >
        ainda sem recadinhos
      </div>
      <p
        style={{
          fontSize: 14,
          color: "var(--ink-soft)",
          marginBottom: 18,
        }}
      >
        Os recadinhos aparecem aqui quando alguém escolhe um presente
        e deixa uma mensagem pro {babyName} no checkout.
      </p>
      <a href="#presentes" className="btn-lilac no-underline">
        Escolher presente
      </a>
    </div>
  );
}

function MuralSkeleton() {
  return (
    <div
      className="grid gap-7"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
      }}
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders, stable order
          key={`mural-skel-${i}`}
          style={{
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: 18,
            padding: "22px 22px 18px",
            minHeight: 180,
            opacity: 0.5,
          }}
        />
      ))}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * Deterministic hash from an opaque pagamento UUID string. Used to pick
 * a stable rotation + avatar color per recado without persisting either
 * on the visitor projection. djb2-style mix; the modulus is taken at
 * the call site so the seed can feed multiple decisions independently.
 */
function hashSeed(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i += 1) {
    h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const AVATAR_PALETTE: readonly string[] = [
  "var(--coral-pink)",
  "var(--lilac-deep)",
  "var(--green)",
  "var(--blue)",
  "var(--lilac)",
];

/**
 * Pull at most two display-initials from a free-form nome. Handles
 * empty / single-word / multi-word inputs; falls back to "?" when the
 * input is unusable (defensive — the procedure already filters out
 * null contribuintes but the field is still a free-text Stripe input).
 */
function computeInitials(nome: string): string {
  const parts = nome
    .trim()
    .split(/\s+/u)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0] ?? "";
    return first.slice(0, 2).toUpperCase();
  }
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/**
 * pt-BR relative-time formatter. Inline (no new lib dependency) — the
 * mural only needs a handful of buckets and these are the buckets the
 * mocked copy used. `now` is injected for testability; default is
 * `new Date()` at the call site.
 */
export function formatRelativeTime(when: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - when.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "agora há pouco";
  if (minutes < 60) return minutes === 1 ? "há 1 minuto" : `há ${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "há 1 hora" : `há ${hours} horas`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "há 1 semana" : `há ${weeks} semanas`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "há 1 mês" : `há ${months} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? "há 1 ano" : `há ${years} anos`;
}
