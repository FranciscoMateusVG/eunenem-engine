import { useMemo, useState, type CSSProperties } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  RECADOS_SEED,
  avatarFor,
  fmtValue,
  initialsOf,
  type Recado,
} from "@/lib/mocks/mensagens";

// aperture-1oafq — "Mensagens recebidas" (recados de quem presenteou).
//
// Content-only body for /painel/:slug/mensagens. The topbar / shell / Tweaks
// come from PainelLayout — this renders ONLY the page content, matching the
// painel-body conventions established by ConvidadosBody / PresentesBody.
//
// There is NO dedicated design export for this page, so it is built
// DESIGN-CONSISTENT with the EuNeném Sistema de Design:
//   - header card (radial lilás "stained paper" pseudo-glow) with the count of
//     recados, a "X novas" pink badge, a Caveat eyebrow ("recadinhos ♡") and a
//     Patrick Hand title ("mensagens recebidas") with yellow marca-texto.
//   - filter chips (todas / não lidas).
//   - a list of recado cards: gradient-placeholder avatar + initials, name, the
//     affectionate message (Caveat, quoted), a gift/value chip
//     ("presenteou com R$ 120,00 · Kit body"), a date, and an
//     "agradecer ♡" affordance. Unread recados carry a soft lilás "stamp" tint
//     + a "nova ♡" handwritten mark.
//
// Mock-first: no fetch / auth / backend. Marking-as-read and "agradecer" all
// mutate local state and surface a sonner toast. Styling uses the global
// design tokens (--plum / --lilac / --coral-pink / --yellow, plum-tinted
// shadows) so it inherits the scrapbook aesthetic.

const SHADOW_SM = "0 2px 10px rgba(107, 60, 94, 0.06)";
const SHADOW_MD = "0 14px 36px rgba(107, 60, 94, 0.1)";

const FONT_HAND = "var(--font-patrick-hand), cursive";
const FONT_CAVEAT = "var(--font-caveat), cursive";
const FONT_SANS = "var(--font-dm-sans), system-ui, sans-serif";

// ---------- icons (stroke style, mirrors sibling bodies) ----------
function Icon({
  size = 16,
  sw = 1.8,
  style,
  children,
}: {
  size?: number;
  sw?: number;
  style?: CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const IconGift = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} sw={1.7} style={p.style}>
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13" />
    <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8" />
    <path d="M16.5 8a2.5 2.5 0 0 0 0-5C13 3 12 8 12 8" />
  </Icon>
);
const IconHeart = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} sw={1.8} style={p.style}>
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </Icon>
);
const IconCheck = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} sw={2} style={p.style}>
    <polyline points="20 6 9 17 4 12" />
  </Icon>
);
const IconMail = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} sw={1.7} style={p.style}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </Icon>
);

// ---------- recado card ----------
function RecadoCard({
  r,
  onThank,
  onToggleRead,
}: {
  r: Recado;
  onThank: (r: Recado) => void;
  onToggleRead: (id: number) => void;
}) {
  const pal = avatarFor(r.name);
  const firstName = r.name.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0];

  return (
    <article
      style={{
        background: r.read
          ? "var(--paper)"
          : "linear-gradient(135deg, var(--paper), rgba(232, 213, 240, 0.35))",
        border: `1px solid ${r.read ? "var(--line)" : "rgba(167, 123, 190, 0.4)"}`,
        borderRadius: 22,
        padding: "18px 20px",
        display: "flex",
        gap: 14,
        position: "relative",
        boxShadow: r.read ? SHADOW_SM : SHADOW_MD,
      }}
    >
      {!r.read && (
        <span
          style={{
            position: "absolute",
            top: 12,
            right: 16,
            fontFamily: FONT_CAVEAT,
            fontSize: 18,
            color: "var(--coral-pink)",
            transform: "rotate(-6deg)",
            pointerEvents: "none",
          }}
        >
          nova ♡
        </span>
      )}

      {/* avatar */}
      <div
        style={{
          width: 46,
          height: 46,
          flexShrink: 0,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontFamily: FONT_HAND,
          fontSize: 19,
          border: "2.5px solid var(--paper)",
          boxShadow: SHADOW_SM,
          background: pal.bg,
          color: pal.fg,
        }}
        aria-hidden="true"
      >
        {initialsOf(r.name)}
      </div>

      {/* body */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          minWidth: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: FONT_HAND,
              fontSize: 21,
              color: "var(--plum)",
              lineHeight: 1.1,
            }}
          >
            {r.name}
          </span>
          <span
            style={{
              fontFamily: FONT_SANS,
              fontSize: 12.5,
              color: "var(--ink-mute)",
              whiteSpace: "nowrap",
            }}
          >
            {r.date}
          </span>
        </div>

        <p
          style={{
            fontFamily: FONT_CAVEAT,
            fontSize: 21,
            lineHeight: 1.3,
            color: "var(--ink)",
            margin: 0,
          }}
        >
          &ldquo;{r.message}&rdquo;
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 2,
          }}
        >
          {/* gift chip */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 13px",
              borderRadius: 999,
              background: "var(--cream-2)",
              border: "1px solid var(--line)",
              fontFamily: FONT_SANS,
              fontSize: 13,
              color: "var(--ink-soft)",
            }}
          >
            <IconGift size={15} style={{ color: "var(--coral-pink)" }} />
            presenteou com{" "}
            <strong style={{ color: "var(--plum)", fontWeight: 600 }}>
              {fmtValue(r.valueCents)}
            </strong>
            <span style={{ color: "var(--ink-mute)" }}>·</span>
            {r.giftLabel}
          </span>

          {/* actions */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => onToggleRead(r.id)}
              title={r.read ? "marcar como não lida" : "marcar como lida"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 999,
                border: "1px solid var(--line)",
                background: "transparent",
                color: "var(--ink-soft)",
                cursor: "pointer",
                fontFamily: FONT_SANS,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {r.read ? <IconMail size={13} /> : <IconCheck size={13} />}
              {r.read ? "marcar não lida" : "marcar lida"}
            </button>
            <button
              type="button"
              onClick={() => onThank(r)}
              title={`agradecer ${firstName}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "9px 16px",
                borderRadius: 999,
                border: 0,
                background:
                  "linear-gradient(135deg, var(--lilac), var(--lilac-deep))",
                color: "#fff",
                cursor: "pointer",
                fontFamily: FONT_SANS,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                boxShadow: "var(--shadow-cta)",
                whiteSpace: "nowrap",
              }}
            >
              <IconHeart size={13} /> agradecer ♡
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

// ---------- page body ----------
export function MensagensBody({ slug: _slug }: PainelSectionBodyProps) {
  const [recados, setRecados] = useState<Recado[]>(RECADOS_SEED);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const unreadCount = useMemo(
    () => recados.filter((r) => !r.read).length,
    [recados],
  );

  const visible = useMemo(
    () => (filter === "unread" ? recados.filter((r) => !r.read) : recados),
    [recados, filter],
  );

  const thank = (r: Recado) => {
    const firstName = r.name.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0];
    setRecados((rs) =>
      rs.map((x) => (x.id === r.id ? { ...x, read: true } : x)),
    );
    toast.success(`agradecimento enviado pra ${firstName} ♡`);
  };

  const toggleRead = (id: number) => {
    setRecados((rs) =>
      rs.map((x) => (x.id === id ? { ...x, read: !x.read } : x)),
    );
  };

  const markAllRead = () => {
    if (!unreadCount) {
      toast("nenhum recado novo por aqui ♡");
      return;
    }
    setRecados((rs) => rs.map((x) => ({ ...x, read: true })));
    toast.success("tudo lido ♡");
  };

  const filterChips: [typeof filter, string, number][] = [
    ["all", "todas", recados.length],
    ["unread", "não lidas", unreadCount],
  ];

  return (
    <section
      style={{
        margin: "18px auto 0",
        padding: "0 16px",
        maxWidth: 720,
        display: "flex",
        flexDirection: "column",
        gap: 22,
      }}
    >
      {/* header card */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: 26,
          boxShadow: SHADOW_MD,
          padding: 26,
        }}
      >
        {/* radial lilás "stained paper" glow */}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -60,
            right: -60,
            width: 240,
            height: 240,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(232, 213, 240, 0.5), transparent 70%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative" }}>
          <span
            style={{
              fontFamily: FONT_CAVEAT,
              fontSize: 22,
              color: "var(--coral-pink)",
              display: "inline-block",
              transform: "rotate(-3deg)",
              transformOrigin: "left",
            }}
          >
            recadinhos ♡
          </span>
          <h1
            style={{
              fontFamily: FONT_HAND,
              fontSize: 40,
              lineHeight: 1.05,
              color: "var(--plum)",
              margin: "4px 0 8px",
              fontWeight: 400,
            }}
          >
            mensagens <span className="hl">recebidas</span>
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <p
              style={{
                fontFamily: FONT_SANS,
                fontSize: 15,
                color: "var(--ink-soft)",
                margin: 0,
              }}
            >
              {recados.length} recados de quem presenteou o seu bebê.
            </p>
            {unreadCount > 0 && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 11px",
                  borderRadius: 999,
                  background: "var(--pink-soft)",
                  color: "var(--coral-pink)",
                  border: "1px solid rgba(231, 143, 167, 0.4)",
                  fontFamily: FONT_SANS,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "lowercase",
                }}
              >
                {unreadCount} {unreadCount === 1 ? "nova" : "novas"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* filter chips + mark-all */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {filterChips.map(([k, label, c]) => {
            const active = filter === k;
            return (
              <button
                type="button"
                key={k}
                aria-pressed={active}
                onClick={() => setFilter(k)}
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "7px 13px",
                  borderRadius: 999,
                  border: `1px solid ${active ? "var(--lilac)" : "var(--line)"}`,
                  background: active ? "var(--lilac-soft)" : "var(--paper)",
                  color: active ? "var(--plum)" : "var(--ink-soft)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {label}{" "}
                <span
                  style={{
                    background: "rgba(255,255,255,0.6)",
                    color: "var(--plum)",
                    padding: "1px 7px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {c}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={markAllRead}
          disabled={!unreadCount}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid var(--line)",
            background: "transparent",
            color: "var(--ink-soft)",
            cursor: unreadCount ? "pointer" : "default",
            opacity: unreadCount ? 1 : 0.5,
            fontFamily: FONT_SANS,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          <IconCheck size={13} /> marcar tudo como lido
        </button>
      </div>

      {/* recado list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {visible.length === 0 ? (
          <div
            style={{
              padding: "48px 16px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontFamily: FONT_HAND,
                fontSize: 28,
                color: "var(--plum)",
              }}
            >
              nenhum recado novo ♡
            </div>
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 15,
                color: "var(--ink-soft)",
                marginTop: 8,
              }}
            >
              você já leu todos os carinhos. veja todas em "todas".
            </div>
          </div>
        ) : (
          visible.map((r) => (
            <RecadoCard
              key={r.id}
              r={r}
              onThank={thank}
              onToggleRead={toggleRead}
            />
          ))
        )}
      </div>
    </section>
  );
}
