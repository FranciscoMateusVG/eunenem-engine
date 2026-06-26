import { useMemo, useRef, useState, useEffect, type CSSProperties } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  CONVIDADOS_SEED,
  CONVIDADOS_EVENT,
  RSVP_META,
  avatarFor,
  initialsOf,
  type Convidado,
  type ConvidadoRsvp,
} from "@/lib/mocks/convidados";
import { PREVIEW_EVENT } from "@/lib/mocks/eventPreview";
// aperture-dkkau — wire the "Mensagem do convite" compositor to the REAL
// convite save (eventoConvite.save → convites table), mirroring ConviteBody.
import {
  conviteErrorMessage,
  conviteStateFromData,
  savePayloadFromConviteState,
  useConviteData,
  useSalvarConvite,
} from "@/lib/convite";
import { DEFAULT_STATE, type ConviteState } from "@/lib/mocks/convite";

// aperture-x1b3u — Lista de convidados (RSVP + convites por WhatsApp).
//
// Content-only body for /painel/:slug/convidados. The topbar / shell /
// Tweaks come from PainelLayout — this renders ONLY the page content,
// matching the "Lista de convidados" design export (app.jsx + styles.css).
//
// Ported faithfully from the export:
//   - filter badges (confirmados · talvez · aguardando · não vão · todos · não enviadas)
//   - título + "adicionar convidado" affordance (inline form, local state)
//   - mensagem padrão card with [nome]/[link] variable chips + invite-type toggle
//   - guest list: per-guest card with WhatsApp send /
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
const IconMoreVertical = (p: { size?: number }) => (
  <Icon size={p.size} sw={2.2}>
    <circle cx="12" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.1" fill="currentColor" stroke="none" />
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
// aperture-ch1kr — clock icon for the VER CONVITE preview card's
// time pill chip. Same stroke style + currentColor as the other
// preview-card icons (calendar / pin) so the chip row stays cohesive.
const IconClock = (p: { size?: number }) => (
  <Icon size={p.size} sw={1.9}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 16 14" />
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

function GuestAvatar({ name }: { name: string }) {
  const pal = avatarFor(name);
  return (
    <div
      className="cv-guest-avatar"
      style={{
        width: 44,
        height: 44,
        flexShrink: 0,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontFamily: FONT_SANS,
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        border: "2px solid var(--paper)",
        boxShadow: SHADOW_SM,
        background: pal.bg,
        color: pal.fg,
      }}
    >
      {initialsOf(name)}
    </div>
  );
}

function RsvpMenu({
  guestId,
  onSetRsvp,
  variant,
}: {
  guestId: number;
  onSetRsvp: (id: number, rsvp: ConvidadoRsvp) => void;
  variant: "desktop" | "mobile";
}) {
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
      ref={menuRef}
      className={
        variant === "mobile" ? "cv-guest-rsvp-mobile" : "cv-guest-rsvp-desktop"
      }
    >
      {variant === "mobile" ? (
        <button
          type="button"
          className="cv-guest-more-btn"
          aria-label="Opções de RSVP"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMoreVertical size={18} />
        </button>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setMenuOpen((v) => !v)}>
          rsvp{" "}
          <IconChevron
            size={12}
            style={{
              transform: menuOpen ? "rotate(90deg)" : "none",
              transition: "transform 140ms",
            }}
          />
        </Button>
      )}
      {menuOpen && (
        <div
          role="menu"
          className="cv-guest-rsvp-dropdown"
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
                onSetRsvp(guestId, k);
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
  );
}

function GuestSendActions({
  g,
  onSend,
  onRemind,
}: {
  g: Convidado;
  onSend: (id: number, isResend?: boolean) => void;
  onRemind: (id: number) => void;
}) {
  return (
    <>
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
    </>
  );
}

function GuestMobilePrimaryAction({
  g,
  onSend,
  onRemind,
}: {
  g: Convidado;
  onSend: (id: number, isResend?: boolean) => void;
  onRemind: (id: number) => void;
}) {
  if (!g.sent) {
    return (
      <Button variant="whatsapp" size="sm" onClick={() => onSend(g.id)}>
        <IconWhatsapp /> enviar
      </Button>
    );
  }

  if (g.rsvp === "maybe") {
    return (
      <Button
        variant="coral"
        size="sm"
        disabled={g.reminded}
        onClick={() => onRemind(g.id)}
      >
        <IconBell /> {g.reminded ? "lembrado" : "lembrar"}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      title="reenviar mensagem"
      onClick={() => onSend(g.id, true)}
    >
      <IconWhatsapp /> reenviar
    </Button>
  );
}

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
  return (
    <div className="cv-guest-card">

      {/* desktop */}
      <div className="cv-guest-layout-desktop">
        <GuestAvatar name={g.name} />

        <div className="cv-guest-desktop-info">
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

        <div className="cv-guest-desktop-actions">
          <GuestSendActions g={g} onSend={onSend} onRemind={onRemind} />
          <RsvpMenu guestId={g.id} onSetRsvp={onSetRsvp} variant="desktop" />
        </div>
      </div>

      {/* mobile */}
      <div className="cv-guest-layout-mobile">
        <div className="cv-guest-mobile-row1">
          <div className="cv-guest-mobile-identity">
            <GuestAvatar name={g.name} />
            <div className="cv-guest-mobile-info">
              <div className="cv-guest-mobile-name">{g.name}</div>
              <span className="cv-guest-mobile-phone">
                <IconPhone size={12} /> {g.phone}
              </span>
            </div>
          </div>
          <RsvpMenu guestId={g.id} onSetRsvp={onSetRsvp} variant="mobile" />
        </div>

        <div className="cv-guest-mobile-row2">
          <SendBadge sent={g.sent} />
          <RsvpBadge rsvp={g.rsvp} />
          {g.reminded && (
            <span className="cv-guest-mobile-reminded">lembrete enviado ♡</span>
          )}
        </div>

        <div className="cv-guest-mobile-row3">
          <GuestMobilePrimaryAction
            g={g}
            onSend={onSend}
            onRemind={onRemind}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- filter badges  ----------
const STAT_BADGE_NEUTRAL = badgeStyle("var(--paper)", "var(--ink-soft)", "var(--line)");

type GuestListFilter = "all" | ConvidadoRsvp | "unsent";

function GuestFilterBadges({
  guests,
  filter,
  onFilterChange,
}: {
  guests: Convidado[];
  filter: GuestListFilter;
  onFilterChange: (filter: GuestListFilter) => void;
}) {
  const total = guests.length;
  const confirmed = guests.filter((g) => g.rsvp === "confirmed").length;
  const maybe = guests.filter((g) => g.rsvp === "maybe").length;
  const declined = guests.filter((g) => g.rsvp === "declined").length;
  const pending = guests.filter((g) => g.rsvp === "pending").length;
  const unsent = guests.filter((g) => !g.sent).length;

  const stats: {
    key: GuestListFilter;
    count: number;
    label: string;
    color: string;
  }[] = [
    { key: "all", count: total, label: "todos", color: "var(--plum)" },
    {
      key: "confirmed",
      count: confirmed,
      label: "confirmados",
      color: RSVP_META.confirmed.color,
    },
    { key: "maybe", count: maybe, label: "talvez", color: RSVP_META.maybe.color },
    {
      key: "pending",
      count: pending,
      label: "aguardando",
      color: RSVP_META.pending.color,
    },
    {
      key: "declined",
      count: declined,
      label: "não vão",
      color: RSVP_META.declined.color,
    },
    {
      key: "unsent",
      count: unsent,
      label: "não enviadas",
      color: "var(--coral-pink)",
    },
  ];

  return (
    <div className="cv-stats-strip">
      <div className="cv-stats-strip-row">
        {stats.map(({ key, count, label, color }) => {
          const active = filter === key;
          return (
            <button
              type="button"
              key={key}
              className="cv-stat-badge"
              aria-pressed={active}
              onClick={() => onFilterChange(key)}
              style={{
                ...STAT_BADGE_NEUTRAL,
                boxShadow: SHADOW_SM,
                ...(active
                  ? { outline: "2px solid var(--lilac)", outlineOffset: 2 }
                  : {}),
              }}
            >
              <StatusDot color={color} />
              <span className="cv-stat-num">{count}</span>
              <span className="cv-stat-lbl">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- add guest modal ----------
//
// Modal chrome reuses the `.lista-scrim` / `.lista-modal` recipe that
// ListaPresentesBody ships in tailwind.css — same scrim, same paper card,
// same 24px radius, same head/body/foot structure, same `.btn .btn-ghost` +
// `.btn .btn-primary` recipe. Keeps this surface visually harmonised with
// the rest of the painel without adding new CSS.

// Format a digits-only string into Brazilian phone "(NN) NNNNN-NNNN" /
// "(NN) NNNN-NNNN". Caps at 11 digits.
function formatBrPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10)
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const BR_MOBILE_PHONE_RE = /^\(\d{2}\) 9\d{4}-\d{4}$/;

function isValidBrMobilePhone(phone: string): boolean {
  return BR_MOBILE_PHONE_RE.test(phone);
}

function capitalizeGuestName(raw: string): string {
  return raw.replace(/\S+/g, (word) => {
    const [first = "", ...rest] = word;
    return first.toUpperCase() + rest.join("").toLowerCase();
  });
}

function AddGuestModal({
  onAdd,
  onClose,
}: {
  onAdd: (g: { name: string; phone: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const submit = () => {
    const n = name.trim();
    if (!n || !isValidBrMobilePhone(phone)) return;
    onAdd({ name: n, phone });
    setName("");
    setPhone("");
    onClose();
  };

  const canSubmit = name.trim().length > 0 && isValidBrMobilePhone(phone);
  const phoneError =
    phone.length > 0 && !isValidBrMobilePhone(phone)
      ? "formato inválido — use (DD) 9XXXX-XXXX"
      : null;

  return (
    <div className="lista-scrim" onClick={onClose}>
      <div
        className="lista-modal lista-modal-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="convidado-modal-title"
      >
        <div className="lista-modal-head">
          <div>
            <h3 id="convidado-modal-title">
              adicionar <span className="hl">convidado</span>
            </h3>
            <p
              style={{
                fontFamily: FONT_SANS,
                fontSize: 13.5,
                color: "var(--ink-soft)",
                margin: "6px 0 0",
                lineHeight: 1.5,
              }}
            >
              só precisamos do nome e do telefone — o resto a gente cuida.
            </p>
          </div>
          <button
            type="button"
            className="lista-modal-x"
            onClick={onClose}
            aria-label="Fechar"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="lista-modal-body">
          <div className="lista-form">
            <div className="lista-field lista-field-full">
              <label htmlFor="convidado-name">nome do convidado</label>
              <div style={{ position: "relative" }}>
                <input
                  id="convidado-name"
                  placeholder="ex: Ana Clara"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(capitalizeGuestName(e.target.value))}
                  onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
                  style={{ paddingRight: 40 }}
                />
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    right: 12,
                    top: "50%",
                    transform: "translateY(-50%)",
                    color: "var(--ink-mute)",
                    display: "inline-flex",
                    pointerEvents: "none",
                  }}
                >
                  <svg
                    width={18}
                    height={18}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
              </div>
            </div>
            <div className="lista-field lista-field-full">
              <label htmlFor="convidado-phone">telefone (com ddd)</label>
              <input
                id="convidado-phone"
                inputMode="tel"
                placeholder="(11) 99999-9999"
                value={phone}
                onChange={(e) => setPhone(formatBrPhone(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
                aria-invalid={phoneError ? true : undefined}
                aria-describedby={phoneError ? "convidado-phone-error" : undefined}
              />
              {phoneError && (
                <p
                  id="convidado-phone-error"
                  role="alert"
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 12,
                    color: "var(--coral-pink)",
                    margin: "6px 0 0",
                    lineHeight: 1.4,
                  }}
                >
                  {phoneError}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="lista-modal-foot">
          <div className="lista-foot-actions" style={{ marginLeft: "auto" }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit}
              onClick={submit}
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden="true"
                style={{ marginRight: 6 }}
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Adicionar à lista
            </button>
          </div>
        </div>
      </div>
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

// ---------- shared virtual invite preview card ----------
//
// Extracted from VerConviteModal so the collapse body can show the same
// card inline when "convite virtual" is selected.

function VirtualInvitePreviewCard() {
  const { eventName, eventNameHighlight, hostName, dateLabel, timeLabel, locationLabel } =
    PREVIEW_EVENT;

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

  const chipStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    borderRadius: 999,
    background: "var(--cream)",
    color: "var(--ink-soft)",
    fontFamily: FONT_SANS,
    fontSize: 11,
    fontWeight: 500,
    border: "1px solid var(--line)",
  };

  const noop = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="cv-virtual-invite-frame">
      <div className="cv-virtual-invite-preview">
        <div className="cv-virtual-invite-greeting">olá ♡ você foi convidada</div>

        <h4 className="cv-virtual-invite-title">{renderHighlighted()}</h4>

        <div className="cv-virtual-invite-host">por {hostName}</div>

        <div className="cv-virtual-invite-chips">
          <span style={chipStyle}>
            <IconCalendar size={13} /> {dateLabel}
          </span>
          <span style={chipStyle}>
            <IconClock size={13} /> {timeLabel}
          </span>
          <span style={chipStyle}>
            <IconPin size={13} /> {locationLabel}
          </span>
        </div>

        <button
          type="button"
          className="cv-virtual-invite-cta"
          onClick={noop}
          aria-hidden="true"
          tabIndex={-1}
        >
          <IconHeart size={13} fill="currentColor" /> confirmar presença
        </button>

        <div className="cv-virtual-invite-footer">mal posso esperar pra te ver ♡</div>
      </div>
    </div>
  );
}

// ---------- aperture-ch1kr — VER CONVITE preview modal (retired) ----------
// Inline 9:16 preview in the collapse replaced the modal entry point.

// ---------- page body ----------
export function ConvidadosBody({ slug: _slug }: PainelSectionBodyProps) {
  const [guests, setGuests] = useState<Convidado[]>(CONVIDADOS_SEED);
  // aperture-dkkau — the compositor now holds the FULL ConviteState (mirroring
  // ConviteBody) so saving re-serializes the whole convite intact. We only
  // expose 4 fields here (message/date/time/address); palette, template,
  // background image, host, babyName, mode etc. are hydrated from the saved
  // convite and round-tripped untouched on save.
  const [state, setState] = useState<ConviteState>({ ...DEFAULT_STATE });
  const conviteQuery = useConviteData();
  const salvarConvite = useSalvarConvite();
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!conviteQuery.data || hydratedRef.current) return;
    setState(conviteStateFromData(conviteQuery.data));
    hydratedRef.current = true;
  }, [conviteQuery.data]);

  const onSaveConvite = async () => {
    try {
      // CONTRACT: start from the full hydrated state, never a hand-built
      // partial — savePayloadFromConviteState re-serializes everything the
      // user set in ConviteBody (palette/template/image/host/babyName/mode).
      await salvarConvite.mutateAsync(savePayloadFromConviteState(state));
      toast.success("convite salvo ♡");
    } catch (error) {
      toast.error("não foi possível salvar o convite agora", {
        description: conviteErrorMessage(error),
      });
    }
  };

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteType, setInviteType] = useState<"virtual" | "text">("virtual");
  const [filter, setFilter] = useState<
    "all" | ConvidadoRsvp | "unsent"
  >("all");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  // aperture-8qg1s — controls the VER LINK preview modal
  const [verLinkOpen, setVerLinkOpen] = useState(false);

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
  const remindOne = (id: number) => {
    setGuests((gs) =>
      gs.map((g) => (g.id === id ? { ...g, reminded: true } : g)),
    );
    toast.success("lembrete enviado ♡");
  };
  const setRsvp = (id: number, rsvp: ConvidadoRsvp) => {
    setGuests((gs) => gs.map((g) => (g.id === id ? { ...g, rsvp } : g)));
  };

  const cardStyle: CSSProperties = {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 24,
    boxShadow: SHADOW_MD,
    padding: 24,
    position: "relative",
  };

  return (
    <section className="cv-convidados-page" style={{ margin: "18px 16px 0", display: "flex", flexDirection: "column", gap: 22 }}>
      {/* 1. título */}
      <div>
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
          className="cv-event-meta"
          style={{
            fontFamily: FONT_SANS,
            fontSize: 15,
            color: "var(--ink-soft)",
            margin: 0,
            maxWidth: 540,
          }}
        >
          <span className="cv-event-meta-item">
            <IconCalendar size={13} /> {CONVIDADOS_EVENT.date}
          </span>
          <span className="cv-event-meta-sep" aria-hidden="true">
            ·
          </span>
          <span className="cv-event-meta-item">
            <IconClock size={13} /> {CONVIDADOS_EVENT.time}
          </span>
        </p>
      </div>

      {showAdd && (
        <AddGuestModal onAdd={addGuest} onClose={() => setShowAdd(false)} />
      )}

      {/* 3. mensagem padrão (colapsável) */}
      <div
        style={{
          ...cardStyle,
          padding: inviteOpen ? 24 : "16px 20px",
        }}
      >
        <button
          type="button"
          className="cv-invite-collapse-trigger"
          aria-expanded={inviteOpen}
          onClick={() => setInviteOpen((open) => !open)}
        >
          <h3
            style={{
              fontFamily: FONT_HAND,
              fontSize: 22,
              color: "var(--plum)",
              margin: 0,
              fontWeight: 400,
            }}
          >
            Mensagem do convite
          </h3>
          <IconChevron
            size={20}
            style={{
              color: "var(--ink-soft)",
              flexShrink: 0,
              transition: "transform 0.25s ease",
              transform: inviteOpen ? "rotate(-90deg)" : "rotate(90deg)",
            }}
          />
        </button>

        {inviteOpen && (
          <div className="cv-invite-collapse-body">
            <div className="convidados-preview-actions">
              <div
                role="tablist"
                aria-label="tipo de convite"
                className="cv-invite-type-toggle"
                onClick={(e) => e.stopPropagation()}
              >
                {(["virtual", "text"] as const).map((t) => {
                  const active = inviteType === t;
                  return (
                    <button
                      type="button"
                      key={t}
                      className="cv-invite-type-btn"
                      aria-pressed={active}
                      onClick={() => setInviteType(t)}
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

            {inviteType === "virtual" ? (
              <VirtualInvitePreviewCard />
            ) : (
              <div className="convidados-msg-grid">
                <div className="convidados-msg-fields">
                  <label className="cv-invite-field">
                    <span className="cv-invite-label">mensagem</span>
                    <textarea
                      className="cv-invite-textarea"
                      value={state.message}
                      onChange={(e) =>
                        setState((s) => ({ ...s, message: e.target.value }))
                      }
                    />
                  </label>

                  <label className="cv-invite-field">
                    <span className="cv-invite-label">
                      <IconPin size={13} /> endereço
                    </span>
                    <input
                      className="cv-invite-input"
                      type="text"
                      value={state.address}
                      onChange={(e) =>
                        setState((s) => ({ ...s, address: e.target.value }))
                      }
                    />
                  </label>

                  <div className="convidados-msg-datetime">
                    <label className="cv-invite-field">
                      <span className="cv-invite-label">
                        <IconCalendar size={13} /> data
                      </span>
                      <input
                        className="cv-invite-input"
                        type="date"
                        value={state.date}
                        onChange={(e) =>
                          setState((s) => ({ ...s, date: e.target.value }))
                        }
                      />
                    </label>
                    <label className="cv-invite-field">
                      <span className="cv-invite-label">
                        <IconClock size={13} /> horário
                      </span>
                      <input
                        className="cv-invite-input"
                        type="time"
                        value={state.time}
                        onChange={(e) =>
                          setState((s) => ({ ...s, time: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            <div className="convidados-preview-btns">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVerLinkOpen(true)}
                title="Ver link de confirmação"
                ariaLabel="Ver link de confirmação"
              >
                <IconLink size={14} /> Pré-visualizar link
              </Button>
              {/* aperture-dkkau — persist the convite via eventoConvite.save */}
              <Button
                variant="primary"
                size="sm"
                onClick={onSaveConvite}
                disabled={salvarConvite.isPending}
                title="Salvar convite"
                ariaLabel="Salvar convite"
              >
                <IconHeart size={14} fill="currentColor" />{" "}
                {salvarConvite.isPending ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* busca + filtros */}
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
            width: "100%",
            maxWidth: 400,
            outline: "none",
          }}
        />
      </div>

      <GuestFilterBadges
        guests={guests}
        filter={filter}
        onFilterChange={setFilter}
      />

      <div className="cv-add-guest-desktop">
        <Button variant="primary" onClick={() => setShowAdd(true)}>
          <IconPlus size={16} /> adicionar convidado
        </Button>
      </div>

      {/* 4. guest list */}
      <div className="cv-guest-list-wrap">
        <div className="cv-guest-list">
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

      <div className="cv-add-guest-fab">
        <Button variant="primary" onClick={() => setShowAdd(true)}>
          <IconPlus size={16} /> adicionar convidado
        </Button>
      </div>

      {/* desktop: message textarea + variables side-by-side */}
      <style>{`
        .cv-event-meta {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
        }
        .cv-event-meta-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .cv-event-meta-sep {
          opacity: 0.55;
        }
        .cv-convidados-page {
          padding-bottom: 88px;
        }
        .cv-add-guest-desktop {
          display: none;
        }
        .cv-add-guest-fab {
          position: fixed;
          left: 16px;
          right: 16px;
          bottom: max(16px, env(safe-area-inset-bottom));
          z-index: 50;
        }
        .cv-add-guest-fab > button {
          width: 100%;
          justify-content: center;
          box-shadow: var(--shadow-cta);
        }
        .cv-stats-strip {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          -ms-overflow-style: none;
          margin: 0 -4px;
          padding: 4px 2px;
        }
        .cv-stats-strip::-webkit-scrollbar { display: none; }
        .cv-stats-strip-row {
          display: flex;
          flex-wrap: nowrap;
          gap: 10px;
          min-width: min-content;
        }
        .cv-stat-badge {
          cursor: pointer;
          user-select: none;
          padding: 10px 16px;
          gap: 8px;
          font-size: 12px;
          border: 0;
          font: inherit;
        }
        .cv-stat-num {
          font-family: var(--font-patrick-hand), cursive;
          font-size: 22px;
          line-height: 1;
          color: var(--plum);
          font-weight: 400;
          text-transform: none;
          letter-spacing: normal;
        }
        .cv-stat-lbl {
          font-family: var(--font-dm-sans), sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 600;
          font-size: 11px;
          color: var(--ink-soft);
        }
        .convidados-msg-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
          align-items: stretch;
        }
        .convidados-msg-fields {
          display: flex;
          flex-direction: column;
          gap: 14px;
          min-width: 0;
        }
        .convidados-msg-datetime {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }
        .convidados-msg-vars {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 180px;
        }
        .cv-invite-collapse-trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          width: 100%;
          border: 0;
          background: transparent;
          padding: 0;
          margin: 0;
          cursor: pointer;
          text-align: left;
        }
        .cv-invite-collapse-body {
          margin-top: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .cv-invite-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;
        }
        .cv-invite-label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: var(--font-dm-sans), sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          font-weight: 600;
          font-size: 11px;
          color: var(--ink-soft);
        }
        .cv-invite-input,
        .cv-invite-textarea {
          width: 100%;
          font-family: var(--font-patrick-hand), cursive;
          font-size: 18px;
          line-height: 1.55;
          color: var(--ink);
          background: var(--cream);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 12px 14px;
          outline: none;
          box-sizing: border-box;
        }
        .cv-invite-input {
          height: 48px;
          line-height: 1.2;
        }
        .cv-invite-textarea {
          min-height: 180px;
          resize: vertical;
        }
        .convidados-preview-actions {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 0;
          width: 100%;
        }
        .cv-invite-type-toggle {
          display: flex;
          width: 100%;
          background: var(--cream-2);
          border-radius: 999px;
          padding: 4px;
          border: 1px solid var(--line);
          gap: 2px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .cv-invite-type-btn {
          flex: 1;
          font-family: var(--font-dm-sans), sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 600;
          font-size: 11px;
          padding: 9px 16px;
          border-radius: 999px;
          border: 0;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: transparent;
          color: var(--ink-soft);
        }
        .cv-invite-type-btn[aria-pressed="true"] {
          background: var(--paper);
          color: var(--plum);
          box-shadow: 0 2px 10px rgba(107, 60, 94, 0.06);
        }
        .convidados-preview-btns {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: 100%;
        }
        .convidados-preview-btns > button {
          width: 100%;
          justify-content: center;
        }
        .cv-virtual-invite-frame {
          width: min(72vw, 220px);
          margin-inline: auto;
          aspect-ratio: 9 / 16;
        }
        .cv-virtual-invite-preview {
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          padding: clamp(14px, 3.5vw, 20px) clamp(12px, 3vw, 18px);
          border-radius: 18px;
          background:
            linear-gradient(135deg, var(--lilac-soft) 0%, var(--pink-soft) 100%);
          border: 1px solid var(--line);
          box-shadow: 0 10px 28px rgba(107, 60, 94, 0.1);
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: clamp(6px, 1.8vw, 10px);
        }
        .cv-virtual-invite-greeting {
          font-family: var(--font-caveat), cursive;
          color: var(--plum);
          font-size: clamp(18px, 4.5vw, 22px);
          line-height: 1.1;
          font-weight: 600;
        }
        .cv-virtual-invite-title {
          font-family: var(--font-patrick-hand), cursive;
          font-size: clamp(22px, 5.5vw, 28px);
          color: var(--plum);
          margin: 0;
          line-height: 1.05;
          font-weight: 400;
        }
        .cv-virtual-invite-host {
          font-family: var(--font-caveat), cursive;
          color: var(--plum);
          font-size: clamp(14px, 3.5vw, 17px);
          font-style: italic;
        }
        .cv-virtual-invite-chips {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 5px;
          width: 100%;
        }
        .cv-virtual-invite-cta {
          font-family: var(--font-dm-sans), sans-serif;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-weight: 600;
          font-size: 10px;
          padding: 9px 16px;
          border-radius: 999;
          cursor: default;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border: 1px solid transparent;
          background: linear-gradient(135deg, var(--lilac), var(--lilac-deep));
          color: #fff;
          box-shadow: var(--shadow-cta);
        }
        .cv-virtual-invite-footer {
          font-family: var(--font-caveat), cursive;
          color: var(--plum);
          font-size: clamp(13px, 3.2vw, 16px);
          line-height: 1.1;
        }
        .cv-guest-list-wrap {
          background: transparent;
          border: 0;
          border-radius: 0;
          box-shadow: none;
          padding: 0;
        }
        .cv-guest-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .cv-guest-card {
          background: var(--paper);
          border: 1px solid var(--line);
          border-radius: 22px;
          padding: 16px 18px;
          position: relative;
          box-shadow: 0 2px 10px rgba(107, 60, 94, 0.06);
        }
        .cv-guest-stamp {
          position: absolute;
          top: 10px;
          right: 14px;
          font-family: var(--font-caveat), cursive;
          font-size: 18px;
          color: var(--green-deep);
          transform: rotate(-6deg);
          opacity: 0.55;
          pointer-events: none;
        }
        .cv-guest-layout-desktop {
          display: none;
        }
        .cv-guest-layout-mobile {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .cv-guest-mobile-row1 {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .cv-guest-mobile-identity {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
          flex: 1;
        }
        .cv-guest-mobile-info {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }
        .cv-guest-mobile-name {
          font-family: var(--font-patrick-hand), cursive;
          font-size: 22px;
          color: var(--plum);
          line-height: 1.1;
        }
        .cv-guest-mobile-phone {
          font-family: var(--font-dm-sans), sans-serif;
          font-size: 13px;
          color: var(--ink-soft);
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .cv-guest-rsvp-mobile,
        .cv-guest-rsvp-desktop {
          position: relative;
          flex-shrink: 0;
        }
        .cv-guest-more-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: var(--paper);
          color: var(--ink-soft);
          cursor: pointer;
          padding: 0;
        }
        .cv-guest-mobile-row2 {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .cv-guest-mobile-reminded {
          font-family: var(--font-caveat), cursive;
          font-size: 16px;
          color: var(--coral-pink);
          transform: rotate(-3deg);
        }
        .cv-guest-mobile-row3 {
          width: 100%;
        }
        .cv-guest-mobile-row3 > button {
          width: 100%;
          justify-content: center;
        }
        @media (min-width: 760px) {
          .convidados-msg-grid { grid-template-columns: 1fr auto; }
          .convidados-preview-actions {
            align-items: center;
          }
          .cv-invite-type-toggle {
            width: 50%;
            margin-inline: auto;
          }
          .convidados-preview-btns {
            flex-direction: row;
            flex-wrap: wrap;
            justify-content: center;
            width: auto;
          }
          .convidados-preview-btns > button {
            width: auto;
          }
          .cv-virtual-invite-frame {
            width: min(100%, 260px);
          }
          .cv-convidados-page {
            padding-bottom: 0;
          }
          .cv-add-guest-desktop {
            display: flex;
            justify-content: flex-end;
          }
          .cv-add-guest-fab {
            display: none;
          }
          .cv-guest-list-wrap {
            background: var(--paper);
            border: 1px solid var(--line);
            border-radius: 24px;
            box-shadow: 0 14px 36px rgba(107, 60, 94, 0.1);
            padding: 24px;
            position: relative;
          }
          .cv-guest-layout-desktop {
            display: flex;
            gap: 14px;
            align-items: center;
            flex-wrap: wrap;
          }
          .cv-guest-layout-mobile {
            display: none;
          }
          .cv-guest-desktop-info {
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;
            flex: 1 1 200px;
          }
          .cv-guest-desktop-actions {
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
            margin-left: auto;
          }
        }
      `}</style>

      {/* aperture-8qg1s — VER LINK preview modal */}
      {verLinkOpen && <VerLinkModal onClose={() => setVerLinkOpen(false)} />}
    </section>
  );
}
