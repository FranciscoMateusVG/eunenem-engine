import { useMemo, useRef, useState, useEffect, type CSSProperties } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  CONVIDADOS_SEED,
  CONVIDADOS_DEFAULT_MESSAGE,
  CONVIDADOS_EVENT,
  RSVP_META,
  avatarFor,
  initialsOf,
  type Convidado,
  type ConvidadoRsvp,
} from "@/lib/mocks/convidados";
import { PREVIEW_EVENT } from "@/lib/mocks/eventPreview";

// aperture-x1b3u — Lista de convidados (RSVP + convites por WhatsApp).
//
// Content-only body for /painel/:slug/convidados. The topbar / shell /
// Tweaks come from PainelLayout — this renders ONLY the page content,
// matching the "Lista de convidados" design export (app.jsx + styles.css).
//
// Ported faithfully from the export:
//   - stats strip (confirmados · talvez · aguardando · não vão + envio %)
//   - título + "adicionar convidado" affordance (inline form, local state)
//   - mensagem padrão card with [nome]/[link] variable chips + invite-type toggle
//   - guest list: search, filter chips, per-guest card with WhatsApp send /
//     reenviar / lembrar + an RSVP override dropdown, and the "recebido ♡"
//     handwritten stamp on confirmed guests.
//
// Mock-first: no fetch / auth / backend. Every action mutates local state
// and surfaces a sonner toast. Styling uses the eunenem-server design
// tokens (--plum/--lilac/--green-deep/--coral-pink/--yellow, plum-tinted
// shadows) so it inherits the scrapbook aesthetic globally.

const SHADOW_SM = "0 2px 10px rgba(107, 60, 94, 0.06)";
const SHADOW_MD = "0 14px 36px rgba(107, 60, 94, 0.1)";

const FONT_HAND = "var(--font-patrick-hand), cursive";
const FONT_CAVEAT = "var(--font-caveat), cursive";
const FONT_SANS = "var(--font-dm-sans), system-ui, sans-serif";

// ---------- small icon helper (stroke style, mirrors export icons) ----------
function Icon({
  size = 16,
  fill = "none",
  stroke = "currentColor",
  sw = 1.8,
  style,
  children,
}: {
  size?: number;
  fill?: string;
  stroke?: string;
  sw?: number;
  style?: CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
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

const IconPlus = (p: { size?: number }) => (
  <Icon size={p.size}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Icon>
);
const IconBell = (p: { size?: number }) => (
  <Icon size={p.size}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Icon>
);
const IconPhone = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} style={p.style}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </Icon>
);
const IconSearch = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} style={p.style}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Icon>
);
const IconChevron = (p: { size?: number; style?: CSSProperties }) => (
  <Icon size={p.size} style={p.style}>
    <polyline points="9 18 15 12 9 6" />
  </Icon>
);
const IconSparkle = (p: { size?: number }) => (
  <Icon size={p.size}>
    <path d="M12 2v6" />
    <path d="M12 16v6" />
    <path d="M5 12H2" />
    <path d="M22 12h-3" />
    <path d="M5 5l2 2" />
    <path d="M17 17l2 2" />
    <path d="M5 19l2-2" />
    <path d="M17 7l2-2" />
  </Icon>
);
// aperture-gnxal — two interlocking links for the "ver link" CTA on
// the mensagem-padrão section. Stroke-based + currentColor so it
// inherits the section's ghost-button ink colour.
const IconLink = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
    <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
  </Icon>
);
// aperture-gnxal — eye outline + center pupil for the "ver convite"
// CTA. Same stroke style as the rest of the section's icons so the
// two new buttons read as a paired affordance.
const IconEye = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
// aperture-8qg1s — icons for the VER LINK preview modal: copy
// (clipboard COPIAR action), calendar + map-pin (preview chips),
// heart (primary RSVP), question (maybe RSVP), x (decline + close
// button). All stroke-based, currentColor, viewBox 24, matching
// the in-file Icon helper.
const IconCopy = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
);
const IconCalendar = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </Icon>
);
const IconPin = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
    <circle cx="12" cy="10" r="3" />
  </Icon>
);
const IconHeart = (p: { size?: number; fill?: string }) => (
  <Icon size={p.size} sw={1.9} fill={p.fill ?? "none"}>
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </Icon>
);
const IconQuestion = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Icon>
);
const IconX = (p: { size?: number }) => (
  <Icon size={p.size} sw={2}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Icon>
);
const IconWhatsapp = (p: { size?: number }) => (
  <svg
    width={p.size ?? 14}
    height={p.size ?? 14}
    viewBox="0 0 24 24"
    fill="currentColor"
    style={{ flexShrink: 0 }}
    aria-hidden="true"
  >
    <path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.9-.4-1.7-1-2.4-1.6-.6-.6-1.1-1.4-1.6-2.2-.2-.3 0-.4.1-.6.1-.1.3-.3.4-.5.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5-.1-.1-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.4 0 1.4 1 2.8 1.2 3 .1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.3A10 10 0 1 0 12 2zm0 18.3a8.3 8.3 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3a8.3 8.3 0 1 1 6.9 3.8z" />
  </svg>
);

// ---------- buttons ----------
type BtnVariant = "primary" | "ghost" | "whatsapp" | "coral";

function btnStyle(variant: BtnVariant, size: "sm" | "md" = "md"): CSSProperties {
  const base: CSSProperties = {
    fontFamily: FONT_SANS,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 600,
    fontSize: size === "sm" ? 11 : 12,
    padding: size === "sm" ? "8px 14px" : "12px 18px",
    borderRadius: 999,
    border: "1px solid var(--line-strong, var(--line))",
    background: "var(--paper)",
    color: "var(--ink)",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    whiteSpace: "nowrap",
    transition: "transform 120ms ease, box-shadow 120ms ease",
  };
  if (variant === "primary")
    return {
      ...base,
      background: "linear-gradient(135deg, var(--lilac), var(--lilac-deep))",
      color: "#fff",
      borderColor: "transparent",
      boxShadow: "var(--shadow-cta)",
    };
  if (variant === "whatsapp")
    return {
      ...base,
      background: "#25D366",
      color: "#fff",
      borderColor: "transparent",
      boxShadow: "0 4px 12px rgba(37, 211, 102, 0.35)",
    };
  if (variant === "coral")
    return {
      ...base,
      background: "var(--coral-pink)",
      color: "#fff",
      borderColor: "transparent",
      boxShadow: "0 4px 12px rgba(231, 143, 167, 0.35)",
    };
  return { ...base, background: "transparent" };
}

function Button({
  variant,
  size = "md",
  disabled,
  onClick,
  title,
  ariaLabel,
  children,
}: {
  variant: BtnVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      style={{ ...btnStyle(variant, size), opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  );
}

// ---------- badges ----------
function StatusDot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
      }}
    />
  );
}

function badgeStyle(bg: string, color: string, border: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 11px",
    borderRadius: 999,
    fontFamily: FONT_SANS,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    border: `1px solid ${border}`,
    whiteSpace: "nowrap",
    background: bg,
    color,
  };
}

function RsvpBadge({ rsvp }: { rsvp: ConvidadoRsvp }) {
  const m = RSVP_META[rsvp];
  const styles: Record<ConvidadoRsvp, CSSProperties> = {
    confirmed: badgeStyle(
      "rgba(199, 220, 110, 0.28)",
      "var(--green-deep)",
      "rgba(138, 165, 58, 0.3)",
    ),
    maybe: badgeStyle(
      "rgba(247, 213, 96, 0.35)",
      "#8a6a14",
      "rgba(247, 213, 96, 0.7)",
    ),
    declined: badgeStyle(
      "var(--pink-soft)",
      "var(--coral-pink)",
      "rgba(231, 143, 167, 0.4)",
    ),
    pending: badgeStyle("var(--cream-2)", "var(--ink-mute)", "var(--line)"),
  };
  return (
    <span style={styles[rsvp]}>
      <StatusDot color={m.color} /> {m.label}
    </span>
  );
}

function SendBadge({ sent }: { sent: boolean }) {
  return sent ? (
    <span
      style={badgeStyle(
        "rgba(199, 220, 110, 0.25)",
        "var(--green-deep)",
        "rgba(138, 165, 58, 0.3)",
      )}
    >
      <StatusDot color="var(--green-deep)" /> mensagem enviada
    </span>
  ) : (
    <span style={badgeStyle("var(--cream-2)", "var(--ink-soft)", "var(--line)")}>
      <StatusDot color="var(--ink-mute)" /> não enviada
    </span>
  );
}

// ---------- guest card ----------
const RSVP_OPTIONS: [ConvidadoRsvp, string, string][] = [
  ["confirmed", "marcar como confirmado", "var(--green-deep)"],
  ["maybe", "marcar como talvez", "#c79b1d"],
  ["declined", "marcar como não vai", "var(--coral-pink)"],
  ["pending", "voltar para aguardando", "var(--ink-mute)"],
];

function GuestCard({
  g,
  onSend,
  onRemind,
  onSetRsvp,
}: {
  g: Convidado;
  onSend: (id: number, isResend?: boolean) => void;
  onRemind: (id: number) => void;
  onSetRsvp: (id: number, rsvp: ConvidadoRsvp) => void;
}) {
  const pal = avatarFor(g.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 22,
        padding: "16px 18px",
        display: "flex",
        gap: 14,
        alignItems: "center",
        flexWrap: "wrap",
        position: "relative",
        boxShadow: SHADOW_SM,
      }}
    >
      {g.rsvp === "confirmed" && (
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 14,
            fontFamily: FONT_CAVEAT,
            fontSize: 18,
            color: "var(--green-deep)",
            transform: "rotate(-6deg)",
            opacity: 0.55,
            pointerEvents: "none",
          }}
        >
          recebido ♡
        </span>
      )}

      <div
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontFamily: FONT_HAND,
          fontSize: 18,
          border: "2px solid var(--paper)",
          boxShadow: SHADOW_SM,
          background: pal.bg,
          color: pal.fg,
        }}
      >
        {initialsOf(g.name)}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minWidth: 0,
          flex: "1 1 200px",
        }}
      >
        <div
          style={{
            fontFamily: FONT_HAND,
            fontSize: 22,
            color: "var(--plum)",
            lineHeight: 1.1,
          }}
        >
          {g.name}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: FONT_SANS,
              fontSize: 13,
              color: "var(--ink-soft)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <IconPhone size={12} /> {g.phone}
          </span>
          <SendBadge sent={g.sent} />
          <RsvpBadge rsvp={g.rsvp} />
          {g.reminded && (
            <span
              style={{
                fontFamily: FONT_CAVEAT,
                fontSize: 16,
                color: "var(--coral-pink)",
                transform: "rotate(-3deg)",
              }}
            >
              lembrete enviado ♡
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginLeft: "auto",
        }}
      >
        {!g.sent && (
          <Button variant="whatsapp" size="sm" onClick={() => onSend(g.id)}>
            <IconWhatsapp /> enviar
          </Button>
        )}
        {g.sent && g.rsvp === "maybe" && (
          <Button
            variant="coral"
            size="sm"
            disabled={g.reminded}
            onClick={() => onRemind(g.id)}
          >
            <IconBell /> {g.reminded ? "lembrado" : "lembrar"}
          </Button>
        )}
        {g.sent && g.rsvp !== "maybe" && (
          <Button
            variant="ghost"
            size="sm"
            title="reenviar mensagem"
            onClick={() => onSend(g.id, true)}
          >
            <IconWhatsapp /> reenviar
          </Button>
        )}

        <div ref={menuRef} style={{ position: "relative" }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMenuOpen((v) => !v)}
          >
            rsvp{" "}
            <IconChevron
              size={12}
              style={{
                transform: menuOpen ? "rotate(90deg)" : "none",
                transition: "transform 140ms",
              }}
            />
          </Button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                background: "var(--paper)",
                border: "1px solid var(--line)",
                borderRadius: 14,
                boxShadow: SHADOW_MD,
                padding: 6,
                minWidth: 200,
                zIndex: 20,
              }}
            >
              {RSVP_OPTIONS.map(([k, label, color]) => (
                <button
                  type="button"
                  key={k}
                  onClick={() => {
                    onSetRsvp(g.id, k);
                    setMenuOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 12px",
                    background: "transparent",
                    border: 0,
                    borderRadius: 10,
                    cursor: "pointer",
                    fontFamily: FONT_SANS,
                    fontSize: 13,
                    color: "var(--ink)",
                  }}
                >
                  <StatusDot color={color} />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- stats strip ----------
function StatsStrip({ guests }: { guests: Convidado[] }) {
  const total = guests.length;
  const sent = guests.filter((g) => g.sent).length;
  const confirmed = guests.filter((g) => g.rsvp === "confirmed").length;
  const maybe = guests.filter((g) => g.rsvp === "maybe").length;
  const declined = guests.filter((g) => g.rsvp === "declined").length;
  const pending = total - confirmed - maybe - declined;
  const pct = total ? Math.round((sent / total) * 100) : 0;

  const stats: [number, string, string][] = [
    [confirmed, "confirmados", "var(--green-deep)"],
    [maybe, "talvez", "#c79b1d"],
    [pending, "aguardando", "var(--ink-mute)"],
    [declined, "não vão", "var(--coral-pink)"],
  ];

  const numStyle: CSSProperties = {
    fontFamily: FONT_HAND,
    fontSize: 22,
    lineHeight: 1,
    color: "var(--plum)",
  };
  const lblStyle: CSSProperties = {
    fontFamily: FONT_SANS,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 600,
    fontSize: 11,
    color: "var(--ink-soft)",
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "12px 20px",
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 999,
        boxShadow: SHADOW_SM,
        flexWrap: "wrap",
      }}
    >
      {stats.map(([num, label, color], i) => (
        <div
          key={label}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {i > 0 && (
            <span
              style={{
                width: 1,
                height: 18,
                background: "var(--line)",
                marginRight: 18,
              }}
            />
          )}
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
            }}
          />
          <span style={numStyle}>{num}</span>
          <span style={lblStyle}>{label}</span>
        </div>
      ))}

      <span style={{ flex: 1, minWidth: 16 }} />

      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          minWidth: 220,
        }}
      >
        <span style={lblStyle}>mensagens</span>
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 100,
            height: 6,
            background: "var(--cream-2)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "linear-gradient(90deg, var(--green), var(--lilac))",
              borderRadius: 999,
              transition: "width 320ms ease",
            }}
          />
        </div>
        <span style={{ ...numStyle, color: "var(--plum)" }}>
          {sent}/{total}
        </span>
      </div>
    </div>
  );
}

// ---------- add guest inline form ----------
function AddGuestForm({
  onAdd,
  onClose,
}: {
  onAdd: (g: { name: string; phone: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const inputStyle: CSSProperties = {
    fontFamily: FONT_SANS,
    fontSize: 15,
    color: "var(--ink)",
    background: "var(--cream)",
    border: "1px solid var(--line)",
    borderRadius: 14,
    padding: "12px 14px",
    width: "100%",
    outline: "none",
  };

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onAdd({ name: n.toLowerCase(), phone: phone.trim() || "—" });
    setName("");
    setPhone("");
    onClose();
  };

  return (
    <div
      style={{
        background: "var(--cream)",
        border: "1px dashed var(--lilac)",
        borderRadius: 18,
        padding: 16,
        display: "flex",
        gap: 10,
        flexWrap: "wrap",
        alignItems: "flex-end",
        marginTop: 14,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "2 1 200px" }}>
        <label style={{ fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)" }}>
          nome
        </label>
        <input
          style={inputStyle}
          placeholder="nome da convidada"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 160px" }}>
        <label style={{ fontFamily: FONT_SANS, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)" }}>
          telefone
        </label>
        <input
          style={inputStyle}
          placeholder="(11) 90000-0000"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      <Button variant="primary" onClick={submit}>
        <IconPlus size={14} /> adicionar
      </Button>
      <Button variant="ghost" onClick={onClose}>
        cancelar
      </Button>
    </div>
  );
}

// ---------- aperture-8qg1s — VER LINK preview modal ----------
//
// Replaces the placeholder toast shipped by aperture-gnxal with the
// real preview modal: URL display row (with working COPIAR) + a
// preview card showing what guests will see on the public confirmation
// page. RSVP buttons inside the preview are DECORATIVE — clicking them
// must not fire any real action (this is a "what your guests see"
// preview, not the live page).
//
// Modal shell intentionally duplicated inline (not lifted to a shared
// file) per the task brief — keeps the diff scoped to one component;
// the dedupe with ListaPresentesBody's Modal is a separate concern.
//
// Event data sourced from the shared PREVIEW_EVENT mock so aperture-ch1kr
// (VER CONVITE modal) can lift the same fields without re-deriving them.

function Modal({
  children,
  onClose,
  sm,
}: {
  children: React.ReactNode;
  onClose: () => void;
  sm?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div className="lista-scrim" onClick={onClose}>
      <div
        className={"lista-modal" + (sm ? " lista-modal-sm" : "")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

function VerLinkModal({ onClose }: { onClose: () => void }) {
  const fullUrl = `${PREVIEW_EVENT.shareDomain}${PREVIEW_EVENT.hostSlug}`;
  const { eventName, eventNameHighlight, greeting, dateLabel, locationLabel } =
    PREVIEW_EVENT;

  // Render the event name with the highlight substring wrapped in <span.hl>.
  // Splits on first occurrence so the marca-texto sits exactly on the keyword.
  const renderHighlighted = () => {
    const idx = eventName.indexOf(eventNameHighlight);
    if (idx < 0) return eventName;
    const before = eventName.slice(0, idx);
    const after = eventName.slice(idx + eventNameHighlight.length);
    return (
      <>
        {before}
        <span className="hl">{eventNameHighlight}</span>
        {after}
      </>
    );
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast.success("link copiado ♡");
    } catch {
      toast("não consegui copiar — copie manualmente ♡");
    }
  };

  const chipStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    borderRadius: 999,
    background: "var(--cream)",
    color: "var(--ink-soft)",
    fontFamily: FONT_SANS,
    fontSize: 13,
    fontWeight: 500,
    border: "1px solid var(--line)",
  };

  const previewBtnBase: CSSProperties = {
    fontFamily: FONT_SANS,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    fontWeight: 600,
    fontSize: 12,
    padding: "12px 18px",
    borderRadius: 999,
    width: "100%",
    cursor: "default",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    border: "1px solid var(--line)",
    background: "var(--paper)",
    color: "var(--ink)",
  };

  const noop = (e: React.MouseEvent) => e.preventDefault();

  return (
    <Modal onClose={onClose}>
      <div className="lista-modal-head">
        <div>
          <span
            style={{
              fontFamily: FONT_CAVEAT,
              color: "var(--plum)",
              fontSize: 22,
              display: "inline-block",
              transform: "rotate(-2deg)",
              lineHeight: 1,
              fontWeight: 600,
            }}
          >
            prévia da página ♡
          </span>
          <h3>
            link de <span className="hl">confirmação</span>
          </h3>
          <p
            style={{
              margin: "8px 0 0",
              fontFamily: FONT_SANS,
              fontSize: 13.5,
              color: "var(--ink-soft)",
            }}
          >
            é assim que seus convidados vão ver — limpinho e direto.
          </p>
        </div>
        <button
          type="button"
          className="lista-modal-x"
          onClick={onClose}
          aria-label="Fechar"
        >
          <IconX size={16} />
        </button>
      </div>

      <div className="lista-modal-body">
        {/* URL display row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            border: "1px solid var(--line)",
            borderRadius: 14,
            background: "var(--cream)",
            marginTop: 4,
          }}
        >
          <IconLink size={16} />
          <span
            style={{
              flex: 1,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 13.5,
              color: "var(--plum)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={fullUrl}
          >
            {fullUrl}
          </span>
          <button
            type="button"
            onClick={copyUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 999,
              border: "1px solid var(--line)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontFamily: FONT_SANS,
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              cursor: "pointer",
              flexShrink: 0,
            }}
            aria-label="Copiar link"
          >
            <IconCopy size={13} /> copiar
          </button>
        </div>

        {/* Preview card — what guests see on the public RSVP page */}
        <div
          style={{
            marginTop: 18,
            padding: "22px 20px",
            borderRadius: 22,
            background:
              "linear-gradient(135deg, var(--lilac-soft) 0%, var(--pink-soft) 100%)",
            border: "1px solid var(--line)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT_CAVEAT,
              color: "var(--plum)",
              fontSize: 22,
              display: "inline-block",
              transform: "rotate(-2deg)",
              lineHeight: 1,
              fontWeight: 600,
            }}
          >
            {greeting}
          </div>
          <h4
            style={{
              fontFamily: FONT_HAND,
              fontSize: 32,
              color: "var(--plum)",
              margin: "8px 0 14px",
              fontWeight: 400,
            }}
          >
            {renderHighlighted()}
          </h4>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              marginBottom: 18,
            }}
          >
            <span style={chipStyle}>
              <IconCalendar size={13} /> {dateLabel}
            </span>
            <span style={chipStyle}>
              <IconPin size={13} /> {locationLabel}
            </span>
          </div>

          <div
            style={{
              fontFamily: FONT_SANS,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--ink-mute)",
              marginBottom: 10,
            }}
          >
            você vem?
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={noop}
              style={{
                ...previewBtnBase,
                background:
                  "linear-gradient(135deg, var(--lilac), var(--lilac-deep))",
                color: "#fff",
                borderColor: "transparent",
                boxShadow: "var(--shadow-cta)",
              }}
              aria-hidden="true"
              tabIndex={-1}
            >
              <IconHeart size={13} fill="currentColor" /> sim, eu vou
              <IconHeart size={13} fill="currentColor" />
            </button>
            <button
              type="button"
              onClick={noop}
              style={previewBtnBase}
              aria-hidden="true"
              tabIndex={-1}
            >
              <IconQuestion size={13} /> talvez
            </button>
            <button
              type="button"
              onClick={noop}
              style={previewBtnBase}
              aria-hidden="true"
              tabIndex={-1}
            >
              <IconX size={13} /> não consigo dessa vez
            </button>
          </div>
        </div>
      </div>

      <div className="lista-modal-foot">
        <div className="lista-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            fechar
          </button>
        </div>
        <div className="lista-foot-actions lista-foot-actions-end">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              toast.success("ficou mesmo ♡");
              onClose();
            }}
          >
            <IconEye size={14} /> ficou lindo ♡
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- page body ----------
export function ConvidadosBody({ slug: _slug }: PainelSectionBodyProps) {
  const [guests, setGuests] = useState<Convidado[]>(CONVIDADOS_SEED);
  const [message, setMessage] = useState(CONVIDADOS_DEFAULT_MESSAGE);
  const [inviteType, setInviteType] = useState<"virtual" | "text">("virtual");
  const [filter, setFilter] = useState<
    "all" | ConvidadoRsvp | "unsent"
  >("all");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  // aperture-8qg1s — controls the VER LINK preview modal
  const [verLinkOpen, setVerLinkOpen] = useState(false);

  const counts = useMemo(
    () => ({
      all: guests.length,
      confirmed: guests.filter((g) => g.rsvp === "confirmed").length,
      maybe: guests.filter((g) => g.rsvp === "maybe").length,
      declined: guests.filter((g) => g.rsvp === "declined").length,
      pending: guests.filter((g) => g.rsvp === "pending").length,
      unsent: guests.filter((g) => !g.sent).length,
    }),
    [guests],
  );

  const filteredGuests = useMemo(() => {
    let list = guests;
    if (filter === "unsent") list = list.filter((g) => !g.sent);
    else if (filter !== "all") list = list.filter((g) => g.rsvp === filter);
    const q = query.trim().toLowerCase();
    if (q)
      list = list.filter(
        (g) => g.name.toLowerCase().includes(q) || g.phone.includes(q),
      );
    return list;
  }, [guests, filter, query]);

  const addGuest = ({ name, phone }: { name: string; phone: string }) => {
    setGuests((gs) => [
      { id: Date.now(), name, phone, sent: false, rsvp: "pending", reminded: false },
      ...gs,
    ]);
    toast.success("convidado adicionado à lista ♡");
  };
  const sendOne = (id: number, isResend?: boolean) => {
    setGuests((gs) => gs.map((g) => (g.id === id ? { ...g, sent: true } : g)));
    toast.success(isResend ? "mensagem reenviada ♡" : "mensagem enviada ♡");
  };
  const sendAllUnsent = () => {
    const n = counts.unsent;
    if (!n) {
      toast("todo mundo já recebeu ♡");
      return;
    }
    setGuests((gs) => gs.map((g) => (g.sent ? g : { ...g, sent: true })));
    toast.success(`${n} mensagens enviadas ♡`);
  };
  const remindOne = (id: number) => {
    setGuests((gs) =>
      gs.map((g) => (g.id === id ? { ...g, reminded: true } : g)),
    );
    toast.success("lembrete enviado ♡");
  };
  const setRsvp = (id: number, rsvp: ConvidadoRsvp) => {
    setGuests((gs) => gs.map((g) => (g.id === id ? { ...g, rsvp } : g)));
  };

  const filterChips: [typeof filter, string, number][] = [
    ["all", "todos", counts.all],
    ["confirmed", "confirmados", counts.confirmed],
    ["maybe", "talvez", counts.maybe],
    ["pending", "aguardando", counts.pending],
    ["declined", "não vão", counts.declined],
    ["unsent", "não enviadas", counts.unsent],
  ];

  const cardStyle: CSSProperties = {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 24,
    boxShadow: SHADOW_MD,
    padding: 24,
    position: "relative",
  };

  return (
    <section style={{ margin: "18px 16px 0", display: "flex", flexDirection: "column", gap: 22 }}>
      {/* 1. stats strip */}
      <StatsStrip guests={guests} />

      {/* 2. título + ações */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 20,
          flexWrap: "wrap",
        }}
      >
        <div>
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
            quem vem ♡
          </span>
          <h1
            style={{
              fontFamily: FONT_HAND,
              fontSize: 40,
              lineHeight: 1.05,
              color: "var(--plum)",
              margin: "4px 0",
              fontWeight: 400,
            }}
          >
            lista de <span className="hl">convidados</span>
          </h1>
          <p
            style={{
              fontFamily: FONT_SANS,
              fontSize: 15,
              color: "var(--ink-soft)",
              margin: 0,
              maxWidth: 540,
            }}
          >
            {CONVIDADOS_EVENT.title} · {CONVIDADOS_EVENT.date} ·{" "}
            {CONVIDADOS_EVENT.location}
          </p>
        </div>
        <Button variant="primary" onClick={() => setShowAdd((v) => !v)}>
          <IconPlus size={16} /> adicionar convidado
        </Button>
      </div>

      {/* 3. mensagem padrão */}
      <div style={cardStyle}>
        <span
          style={{
            position: "absolute",
            top: -12,
            left: 24,
            background: "var(--yellow)",
            padding: "2px 12px",
            borderRadius: 8,
            fontFamily: FONT_CAVEAT,
            fontSize: 18,
            color: "var(--plum)",
            transform: "rotate(-3deg)",
            boxShadow: SHADOW_SM,
          }}
        >
          mensagem padrão ♡
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <h3 style={{ fontFamily: FONT_HAND, fontSize: 22, color: "var(--plum)", margin: 0, fontWeight: 400 }}>
            o que vão receber
          </h3>
          <div
            role="tablist"
            aria-label="tipo de convite"
            style={{
              display: "inline-flex",
              background: "var(--cream-2)",
              borderRadius: 999,
              padding: 4,
              border: "1px solid var(--line)",
              gap: 2,
            }}
          >
            {(["virtual", "text"] as const).map((t) => {
              const active = inviteType === t;
              return (
                <button
                  type="button"
                  key={t}
                  aria-pressed={active}
                  onClick={() => setInviteType(t)}
                  style={{
                    fontFamily: FONT_SANS,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    fontWeight: 600,
                    fontSize: 11,
                    padding: "9px 16px",
                    borderRadius: 999,
                    border: 0,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: active ? "var(--paper)" : "transparent",
                    color: active ? "var(--plum)" : "var(--ink-soft)",
                    boxShadow: active ? SHADOW_SM : "none",
                  }}
                >
                  {t === "virtual" ? (
                    <>
                      <IconSparkle size={12} /> convite virtual
                    </>
                  ) : (
                    "apenas texto"
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="convidados-msg-grid">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            style={{
              fontFamily: FONT_HAND,
              fontSize: 18,
              lineHeight: 1.55,
              color: "var(--ink)",
              background: "var(--cream)",
              border: "1px solid var(--line)",
              borderRadius: 14,
              padding: "12px 14px",
              width: "100%",
              minHeight: 180,
              resize: "vertical",
              outline: "none",
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minWidth: 180,
            }}
          >
            <span
              style={{
                fontFamily: FONT_SANS,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                fontWeight: 600,
                fontSize: 11,
                color: "var(--ink-soft)",
              }}
            >
              variáveis
            </span>
            {([
              ["[nome]", "var(--lilac-deep)"],
              ["[link]", "var(--coral-pink)"],
            ] as const).map(([label, color]) => (
              <span
                key={label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  fontFamily: FONT_SANS,
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "7px 13px",
                  borderRadius: 999,
                  border: "1px solid var(--line)",
                  background: "var(--paper)",
                  color: "var(--ink-soft)",
                }}
              >
                <StatusDot color={color} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <p
          style={{
            fontFamily: FONT_CAVEAT,
            fontSize: 15,
            color: "var(--ink-mute)",
            marginTop: 12,
            marginBottom: 0,
          }}
        >
          use <b style={{ color: "var(--lilac-deep)" }}>[nome]</b> e{" "}
          <b style={{ color: "var(--coral-pink)" }}>[link]</b> — vamos preencher
          pra cada um.
        </p>

        {/* aperture-gnxal — preview-action strip. Two outlined CTAs
            below the textarea hint so the section communicates
            "you can see what this looks like" without competing with
            the inline VARIÁVEIS panel. Follow-up beads land the
            actual previews:
              - aperture-8qg1s replaces VER LINK's toast with the
                confirmation-link preview modal
              - aperture-ch1kr replaces VER CONVITE's toast with the
                convite preview modal
            Until those land, both fire a placeholder toast so the
            surface communicates intent without dead UI. Reuses the
            section's own Button variant="ghost" (NOT the global
            .btn-ghost — this file is fully inline-styled) so the
            chrome stays harmonious with adjacente buttons. */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 14,
            flexWrap: "wrap",
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVerLinkOpen(true)}
            title="Ver link de confirmação"
            ariaLabel="Ver link de confirmação"
          >
            <IconLink size={14} /> ver link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toast("Em breve — preview do convite ♡")}
            title="Ver convite"
            ariaLabel="Ver convite"
          >
            <IconEye size={14} /> ver convite
          </Button>
        </div>
      </div>

      {/* 4. guest list */}
      <div style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 14,
            marginBottom: 16,
          }}
        >
          <div>
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
              a turma toda ♡
            </span>
            <h2 style={{ fontFamily: FONT_HAND, fontSize: 28, color: "var(--plum)", margin: 0, fontWeight: 400 }}>
              convidados
            </h2>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <IconSearch
                size={14}
                style={{
                  position: "absolute",
                  left: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--ink-mute)",
                }}
              />
              <input
                placeholder="buscar por nome ou telefone"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{
                  fontFamily: FONT_SANS,
                  fontSize: 15,
                  color: "var(--ink)",
                  background: "var(--cream)",
                  border: "1px solid var(--line)",
                  borderRadius: 14,
                  padding: "12px 14px 12px 34px",
                  width: 280,
                  maxWidth: "100%",
                  outline: "none",
                }}
              />
            </div>
            <Button
              variant="whatsapp"
              size="sm"
              disabled={!counts.unsent}
              onClick={sendAllUnsent}
            >
              <IconWhatsapp /> enviar para {counts.unsent || "todos"}
            </Button>
          </div>
        </div>

        {showAdd && (
          <AddGuestForm onAdd={addGuest} onClose={() => setShowAdd(false)} />
        )}

        {/* filter chips */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "16px 0" }}>
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

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredGuests.length === 0 ? (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--ink-mute)" }}>
              <div style={{ fontFamily: FONT_HAND, fontSize: 28, color: "var(--plum)" }}>
                nada por aqui ainda ♡
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 15, color: "var(--ink-soft)", marginTop: 8 }}>
                tente outro filtro ou adicione um convidado.
              </div>
            </div>
          ) : (
            filteredGuests.map((g) => (
              <GuestCard
                key={g.id}
                g={g}
                onSend={sendOne}
                onRemind={remindOne}
                onSetRsvp={setRsvp}
              />
            ))
          )}
        </div>
      </div>

      {/* desktop: message textarea + variables side-by-side */}
      <style>{`
        .convidados-msg-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
          align-items: stretch;
        }
        @media (min-width: 760px) {
          .convidados-msg-grid { grid-template-columns: 1fr auto; }
        }
      `}</style>

      {/* aperture-8qg1s — VER LINK preview modal */}
      {verLinkOpen && <VerLinkModal onClose={() => setVerLinkOpen(false)} />}
    </section>
  );
}
