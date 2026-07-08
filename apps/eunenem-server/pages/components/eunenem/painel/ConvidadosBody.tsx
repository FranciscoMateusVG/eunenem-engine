import { useMemo, useRef, useState, useEffect, type CSSProperties } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  CONVIDADOS_EVENT,
  avatarFor,
  initialsOf,
} from "@/lib/mocks/convidados";
// aperture-dkkau — wire the "Mensagem do convite" compositor to the REAL
// convite save (eventoConvite.save → convites table), mirroring ConviteBody.
import {
  conviteErrorMessage,
  conviteStateFromData,
  hasSavedConvite,
  savePayloadFromConviteState,
  useConviteData,
  useConvitePreviewData,
  useSalvarConvite,
} from "@/lib/convite";
// aperture-lista-convidados — wire the guest list + RSVP to the REAL
// backend (eventoListaDeConvidados.* → listas_de_convidados/convidados
// tables), replacing the CONVIDADOS_SEED mock.
import {
  convidadoFromSnapshot,
  convidadosErrorMessage,
  FORMATO_MENSAGEM_CONVITE_DEFAULT,
  PRESENCA_META,
  useAdicionarConvidado,
  useAlterarPresencaConvidado,
  useListaDeConvidadosData,
  useSalvarFormatoMensagem,
  type Convidado,
  type FormatoMensagemConvite,
  type StatusPresencaConvidado,
} from "@/lib/convidados";
import { painelHref } from "@/lib/painelRoutes";
import { useCampanhaRota } from "@/lib/campanha-rota";
import { DEFAULT_STATE, EVENT_BY_ID, EVENT_TYPES, formatDateScrap, type ConviteState } from "@/lib/mocks/convite";
import { getDefaultConviteShareOrigin } from "@/lib/convite-share";
import {
  buildConfirmarPresencaShareUrl,
  buildFallbackWhatsappMessage,
  buildWaUrl,
  buildWhatsappSendPlan,
  defaultConviteMessage,
  formatPhoneForWhatsapp,
  openWhatsappUrl,
} from "@/lib/whatsapp-invite";
import { InvitePreview } from "./ConviteBody";
import { ConfirmarPresencaView } from "@/ConfirmarPresencaPage";

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
// aperture-8qg1s — icons for the guest-facing preview cards/sections:
// calendar + map-pin (info rows), heart (primary RSVP), x (decline +
// close button). All stroke-based, currentColor, viewBox 24, matching
// the in-file Icon helper.
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

// aperture-lista-convidados — single badge for the 5 real `presenca`
// states, replacing the old RsvpBadge/SendBadge pair (send status is now
// part of the domain state, not a separate UI-only flag).
const PRESENCA_BADGE_STYLES: Record<StatusPresencaConvidado, CSSProperties> = {
  nao_enviado: badgeStyle("var(--cream-2)", "var(--ink-soft)", "var(--line)"),
  enviado: badgeStyle(
    "rgba(247, 213, 96, 0.35)",
    "#8a6a14",
    "rgba(247, 213, 96, 0.7)",
  ),
  sim: badgeStyle(
    "rgba(199, 220, 110, 0.28)",
    "var(--green-deep)",
    "rgba(138, 165, 58, 0.3)",
  ),
  talvez: badgeStyle(
    "rgba(247, 213, 96, 0.35)",
    "#8a6a14",
    "rgba(247, 213, 96, 0.7)",
  ),
  nao: badgeStyle(
    "var(--pink-soft)",
    "var(--coral-pink)",
    "rgba(231, 143, 167, 0.4)",
  ),
};

function PresencaBadge({ presenca }: { presenca: StatusPresencaConvidado }) {
  const m = PRESENCA_META[presenca];
  return (
    <span style={PRESENCA_BADGE_STYLES[presenca]}>
      <StatusDot color={m.color} /> {m.label}
    </span>
  );
}

// ---------- guest card ----------
// aperture-lista-convidados — manual override menu only exposes the 3
// final responses. `nao_enviado`/`enviado` are governed by the send flow
// (botão "enviar"), not a manual host override.
const RSVP_OPTIONS: [StatusPresencaConvidado, string, string][] = [
  ["sim", "marcar como confirmado", "var(--green-deep)"],
  ["talvez", "marcar como talvez", "#c79b1d"],
  ["nao", "marcar como não vai", "var(--coral-pink)"],
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
  guestId: string;
  onSetRsvp: (id: string, presenca: StatusPresencaConvidado) => void;
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
  onSend: (id: string, isResend?: boolean) => void;
  onRemind: (id: string) => void;
}) {
  return (
    <>
      {g.presenca === "nao_enviado" && (
        <Button variant="whatsapp" size="sm" onClick={() => onSend(g.id)}>
          <IconWhatsapp /> enviar
        </Button>
      )}
      {g.presenca === "talvez" && (
        <Button
          variant="coral"
          size="sm"
          disabled={g.reminded}
          onClick={() => onRemind(g.id)}
        >
          <IconBell /> {g.reminded ? "lembrado" : "lembrar"}
        </Button>
      )}
      {g.presenca !== "nao_enviado" && g.presenca !== "talvez" && (
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
  onSend: (id: string, isResend?: boolean) => void;
  onRemind: (id: string) => void;
}) {
  if (g.presenca === "nao_enviado") {
    return (
      <Button variant="whatsapp" size="sm" onClick={() => onSend(g.id)}>
        <IconWhatsapp /> enviar
      </Button>
    );
  }

  if (g.presenca === "talvez") {
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
  onSend: (id: string, isResend?: boolean) => void;
  onRemind: (id: string) => void;
  onSetRsvp: (id: string, presenca: StatusPresencaConvidado) => void;
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
            <PresencaBadge presenca={g.presenca} />
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
          <PresencaBadge presenca={g.presenca} />
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

type GuestListFilter = "all" | StatusPresencaConvidado;

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
  const naoEnviado = guests.filter((g) => g.presenca === "nao_enviado").length;
  const enviado = guests.filter((g) => g.presenca === "enviado").length;
  const sim = guests.filter((g) => g.presenca === "sim").length;
  const talvez = guests.filter((g) => g.presenca === "talvez").length;
  const nao = guests.filter((g) => g.presenca === "nao").length;

  const stats: {
    key: GuestListFilter;
    count: number;
    label: string;
    color: string;
  }[] = [
    { key: "all", count: total, label: "todos", color: "var(--plum)" },
    {
      key: "nao_enviado",
      count: naoEnviado,
      label: "não enviadas",
      color: PRESENCA_META.nao_enviado.color,
    },
    {
      key: "enviado",
      count: enviado,
      label: "aguardando resposta",
      color: PRESENCA_META.enviado.color,
    },
    { key: "sim", count: sim, label: "confirmados", color: PRESENCA_META.sim.color },
    { key: "talvez", count: talvez, label: "talvez", color: PRESENCA_META.talvez.color },
    { key: "nao", count: nao, label: "não vão", color: PRESENCA_META.nao.color },
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

function formatHora(time: string): string {
  const [h, m] = time.split(":");
  if (!h) return time;
  return m && m !== "00" ? `${Number(h)}h${m}` : `${Number(h)}h`;
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
  /** Resolves `true` on success (modal closes); `false` leaves it open so the user can retry. */
  onAdd: (g: { name: string; phone: string }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const submit = async () => {
    const n = name.trim();
    if (!n || !isValidBrMobilePhone(phone) || isSubmitting) return;
    setIsSubmitting(true);
    const ok = await onAdd({ name: n, phone });
    setIsSubmitting(false);
    if (ok) {
      setName("");
      setPhone("");
      onClose();
    }
  };

  const canSubmit = name.trim().length > 0 && isValidBrMobilePhone(phone) && !isSubmitting;
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
              {isSubmitting ? "Adicionando…" : "Adicionar à lista"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- ENVIAR CONVITE modal (WhatsApp click-to-chat) ----------
//
// Builds a wa.me link with the composed message + confirmation link and
// opens it, then persists the guest as "enviado". No real WhatsApp API is
// involved — the send itself is the user tapping "Enviar" inside WhatsApp.

function EnviarConviteModal({
  guest,
  slug,
  eventTypeLabel,
  mensagemConvite,
  onClose,
  onSent,
}: {
  guest: Convidado;
  slug: string;
  eventTypeLabel: string;
  mensagemConvite: string;
  onClose: () => void;
  onSent: () => Promise<unknown>;
}) {
  const [mensagem, setMensagem] = useState(() =>
    mensagemConvite.trim().length > 0
      ? mensagemConvite
      : defaultConviteMessage(guest.name, eventTypeLabel),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const canSubmit = mensagem.trim().length > 0 && !isSubmitting;

  const submit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    const toastId = toast.loading("enviando convite ♡");
    const phone = formatPhoneForWhatsapp(guest.phone);

    try {
      let confirmationUrl: string;
      try {
        confirmationUrl = buildConfirmarPresencaShareUrl(
          getDefaultConviteShareOrigin(),
          slug,
          guest.id,
        );
      } catch {
        openWhatsappUrl(buildWaUrl(phone, buildFallbackWhatsappMessage(mensagem)));
        toast.error("não consegui gerar o link automático — avise o convidado por lá mesmo", {
          id: toastId,
        });
        await onSent();
        return;
      }

      const plan = buildWhatsappSendPlan(phone, mensagem, confirmationUrl);
      if (plan.kind === "single") {
        openWhatsappUrl(plan.url);
      } else {
        openWhatsappUrl(plan.firstUrl);
        try {
          await navigator.clipboard.writeText(plan.secondMessage);
          toast("copiei o link de confirmação — cole numa segunda mensagem ♡");
        } catch {
          // Silent fallback — the invite itself still opened correctly.
        }
      }

      await onSent();
      toast.success("convite enviado ♡", { id: toastId });
    } catch (error) {
      toast.error("mensagem aberta no whatsapp, mas não consegui marcar como enviada", {
        id: toastId,
        description: convidadosErrorMessage(error),
      });
    } finally {
      setIsSubmitting(false);
      onClose();
    }
  };

  return (
    <div className="lista-scrim" onClick={onClose}>
      <div
        className="lista-modal lista-modal-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="enviar-convite-modal-title"
      >
        <div className="lista-modal-head">
          <div>
            <h3 id="enviar-convite-modal-title">
              enviar <span className="hl">convite</span>
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
              {guest.name} · {guest.phone}
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
              <label htmlFor="enviar-convite-mensagem">mensagem</label>
              <textarea
                id="enviar-convite-mensagem"
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
                rows={6}
                style={{
                  width: "100%",
                  resize: "vertical",
                  fontFamily: FONT_SANS,
                  fontSize: 14,
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid var(--line)",
                  color: "var(--ink)",
                }}
              />
              {mensagem.trim().length === 0 && (
                <p
                  role="alert"
                  style={{
                    fontFamily: FONT_SANS,
                    fontSize: 12,
                    color: "var(--coral-pink)",
                    margin: "6px 0 0",
                    lineHeight: 1.4,
                  }}
                >
                  a mensagem não pode ficar vazia
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
              {isSubmitting ? "Enviando…" : "Enviar Convite"}
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
  xl,
}: {
  children: React.ReactNode;
  onClose: () => void;
  sm?: boolean;
  xl?: boolean;
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
        className={"lista-modal" + (sm ? " lista-modal-sm" : "") + (xl ? " lista-modal-xl" : "")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}

const PREVIEW_CONVIDADO_NOME = "Convidado Exemplo";
const PREVIEW_CONVIDADO_PRESENCA: StatusPresencaConvidado = "nao_enviado";

/** Shows guests the REAL /confirmar-presenca page, non-interactively — same
 * ConfirmarPresencaView the public page renders, so this can never drift out
 * of sync with what a guest actually sees. No real idConvidado exists here
 * (this is a preview, not a real guest), so nome/presenca are mocked; the
 * convite content (message/date/address/template) is the real saved one. */
function VerLinkModal({
  slug,
  formatoMensagemConvite,
  onClose,
}: {
  slug: string;
  formatoMensagemConvite: FormatoMensagemConvite;
  onClose: () => void;
}) {
  const conviteQuery = useConvitePreviewData(slug);

  return (
    <Modal onClose={onClose} xl>
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
            É assim que seus convidados vão ver — limpinho e direto.
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

      <div className="lista-modal-body" style={{ padding: 0 }}>
        {conviteQuery.isLoading && (
          <p style={{ padding: 24, fontFamily: FONT_SANS, color: "var(--ink-soft)" }}>
            carregando seu convite...
          </p>
        )}

        {!conviteQuery.isLoading && conviteQuery.error && (
          <div style={{ padding: 24 }}>
            <p style={{ fontFamily: FONT_SANS, color: "var(--ink-soft)", marginBottom: 12 }}>
              não consegui carregar o convite salvo agora.
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void conviteQuery.refetch()}
            >
              tentar de novo
            </button>
          </div>
        )}

        {!conviteQuery.isLoading && !conviteQuery.error && !hasSavedConvite(conviteQuery.data) && (
          <p style={{ padding: 24, fontFamily: FONT_SANS, color: "var(--ink-soft)" }}>
            ainda não existe convite salvo para pré-visualizar.
          </p>
        )}

        {!conviteQuery.isLoading && hasSavedConvite(conviteQuery.data) && (
          <ConfirmarPresencaView
            slug={slug}
            nome={PREVIEW_CONVIDADO_NOME}
            presenca={PREVIEW_CONVIDADO_PRESENCA}
            formatoMensagemConvite={formatoMensagemConvite}
            state={conviteStateFromData(conviteQuery.data)}
            interactive={false}
          />
        )}
      </div>

      <div className="lista-modal-foot">
        <div className="lista-foot-actions" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            fechar
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- real virtual invite preview ----------
//
// Replaces the old PREVIEW_EVENT-backed mock card: shows the user's actual
// saved convite (same InvitePreview renderer as ConvitePreviewBody) when one
// exists, otherwise a "criar convite" prompt. Mirrors the loading/error/empty
// branching of ConvitePreviewBody so the two surfaces stay consistent.

function VirtualInvitePreviewSection({
  slug,
  conviteQuery,
  state,
}: {
  slug: string;
  conviteQuery: ReturnType<typeof useConviteData>;
  state: ConviteState;
}) {
  // aperture-h0hom — preserve the campanha route context in the CTA link.
  const idCampanha = useCampanhaRota();
  if (conviteQuery.isLoading) {
    return (
      <div className="cv-virtual-invite-status">
        carregando seu convite...
      </div>
    );
  }

  if (conviteQuery.error) {
    return (
      <div className="cv-virtual-invite-status">
        <p>não consegui carregar o convite salvo agora.</p>
        <Button variant="ghost" size="sm" onClick={() => void conviteQuery.refetch()}>
          tentar de novo
        </Button>
      </div>
    );
  }

  if (!hasSavedConvite(conviteQuery.data)) {
    return (
      <div className="cv-virtual-invite-status">
        <p>Você ainda não criou seu convite.</p>
        <a href={painelHref(slug, "convite", idCampanha)} style={btnStyle("primary", "sm")}>
          Criar convite
        </a>
      </div>
    );
  }

  return (
    <div className="cv-virtual-invite-frame">
      <InvitePreview state={state} format="story" fidelity="scrapbook" scale={0.6} />
    </div>
  );
}

// ---------- aperture-ch1kr — VER CONVITE preview modal (retired) ----------
// Inline 9:16 preview in the collapse replaced the modal entry point.

// ---------- page body ----------
export function ConvidadosBody({ slug }: PainelSectionBodyProps) {
  // aperture-lista-convidados — the guest list is the real backend source
  // of truth; `reminded` has no domain field, so it's tracked locally
  // (keyed by convidado id) and merged in on render.
  const listaQuery = useListaDeConvidadosData();
  const alterarPresenca = useAlterarPresencaConvidado();
  const adicionarConvidado = useAdicionarConvidado();
  const salvarFormatoMensagem = useSalvarFormatoMensagem();
  const [remindedIds, setRemindedIds] = useState<Set<string>>(new Set());

  const guests = useMemo<Convidado[]>(() => {
    const convidados = listaQuery.data?.lista?.convidados ?? [];
    return convidados.map((c) => {
      const g = convidadoFromSnapshot(c);
      return remindedIds.has(g.id) ? { ...g, reminded: true } : g;
    });
  }, [listaQuery.data, remindedIds]);

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

  // aperture-formato-mensagem — inviteType is hydrated ONCE from the saved
  // formatoMensagemConvite (mirrors the `hydratedRef` pattern for `state`
  // above). Switching tabs only updates local state; it's not persisted
  // until "Salvar" is clicked.
  const [inviteType, setInviteType] = useState<FormatoMensagemConvite>(
    FORMATO_MENSAGEM_CONVITE_DEFAULT,
  );
  const formatoHydratedRef = useRef(false);

  useEffect(() => {
    if (!listaQuery.data || formatoHydratedRef.current) return;
    setInviteType(listaQuery.data.lista?.formatoMensagemConvite ?? FORMATO_MENSAGEM_CONVITE_DEFAULT);
    formatoHydratedRef.current = true;
  }, [listaQuery.data]);

  const onSaveConvite = async () => {
    try {
      // CONTRACT: start from the full hydrated state, never a hand-built
      // partial — savePayloadFromConviteState re-serializes everything the
      // user set in ConviteBody (palette/template/image/host/babyName/mode).
      //
      // Sequential, not Promise.all: salvarFormatoMensagem depends on the
      // Evento existing (eventoListaDeConvidados.salvarFormatoMensagem
      // throws EventoAusenteError if it can't resolve one), and salvarConvite
      // is what creates the Evento on a user's first save. Running them in
      // parallel raced the two requests server-side — the first save could
      // fail with a generic error while silently persisting the Evento,
      // making a retry succeed.
      await salvarConvite.mutateAsync(savePayloadFromConviteState(state));
      await salvarFormatoMensagem.mutateAsync({ formatoMensagemConvite: inviteType });
      toast.success("Salvo com sucesso");
    } catch (error) {
      toast.error("não foi possível salvar agora", {
        description: conviteErrorMessage(error),
      });
    }
  };

  const [inviteOpen, setInviteOpen] = useState(false);
  const [filter, setFilter] = useState<GuestListFilter>("all");
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  // aperture-8qg1s — controls the VER LINK preview modal
  const [verLinkOpen, setVerLinkOpen] = useState(false);
  // Guest currently targeted by the ENVIAR CONVITE modal (null = closed).
  const [sendTarget, setSendTarget] = useState<Convidado | null>(null);
  const eventTypeLabel = (EVENT_BY_ID[state.eventType] ?? EVENT_TYPES[0]!).label;

  const filteredGuests = useMemo(() => {
    let list = guests;
    if (filter !== "all") list = list.filter((g) => g.presenca === filter);
    const q = query.trim().toLowerCase();
    if (q)
      list = list.filter(
        (g) => g.name.toLowerCase().includes(q) || g.phone.includes(q),
      );
    return list;
  }, [guests, filter, query]);

  const addGuest = async ({ name, phone }: { name: string; phone: string }) => {
    try {
      await adicionarConvidado.mutateAsync({ nome: name, numeroCelular: phone });
      toast.success("convidado adicionado à lista ♡");
      return true;
    } catch (error) {
      toast.error("não foi possível adicionar o convidado agora", {
        description: convidadosErrorMessage(error),
      });
      return false;
    }
  };
  const sendOne = (id: string) => {
    const guest = guests.find((g) => g.id === id);
    if (guest) setSendTarget(guest);
  };
  const remindOne = (id: string) => {
    setRemindedIds((ids) => new Set(ids).add(id));
    toast.success("lembrete enviado ♡");
  };
  const setRsvp = async (id: string, presenca: StatusPresencaConvidado) => {
    try {
      await alterarPresenca.mutateAsync({ idConvidado: id, presenca });
    } catch (error) {
      toast.error("não foi possível atualizar o RSVP agora", {
        description: convidadosErrorMessage(error),
      });
    }
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
            <IconCalendar size={13} />{" "}
            {(() => {
              const d = formatDateScrap(state.date);
              return d ? `${d.day} de ${d.monthFull} de ${d.year}` : CONVIDADOS_EVENT.date;
            })()}
          </span>
          <span className="cv-event-meta-sep" aria-hidden="true">
            ·
          </span>
          <span className="cv-event-meta-item">
            <IconClock size={13} /> {state.time ? formatHora(state.time) : CONVIDADOS_EVENT.time}
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
                {(["convite_virtual", "texto"] as const).map((t) => {
                  const active = inviteType === t;
                  return (
                    <button
                      type="button"
                      key={t}
                      className="cv-invite-type-btn"
                      aria-pressed={active}
                      onClick={() => setInviteType(t)}
                    >
                      {t === "convite_virtual" ? (
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

            {inviteType === "convite_virtual" ? (
              <VirtualInvitePreviewSection
                slug={slug}
                conviteQuery={conviteQuery}
                state={state}
              />
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
              {/* aperture-dkkau — persist the convite via eventoConvite.save;
                  aperture-formato-mensagem — same click also persists
                  formatoMensagemConvite via eventoListaDeConvidados.salvarFormatoMensagem */}
              <Button
                variant="primary"
                size="sm"
                onClick={onSaveConvite}
                disabled={salvarConvite.isPending || salvarFormatoMensagem.isPending}
                title="Salvar convite"
                ariaLabel="Salvar convite"
              >
                <IconHeart size={14} fill="currentColor" />{" "}
                {salvarConvite.isPending || salvarFormatoMensagem.isPending ? "Salvando…" : "Salvar"}
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
          {listaQuery.isLoading ? (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--ink-soft)" }}>
              carregando convidados...
            </div>
          ) : listaQuery.error ? (
            <div style={{ padding: "48px 16px", textAlign: "center" }}>
              <div style={{ fontFamily: FONT_SANS, fontSize: 15, color: "var(--ink-soft)" }}>
                não consegui carregar sua lista de convidados agora.
              </div>
              <div style={{ marginTop: 12 }}>
                <Button variant="ghost" size="sm" onClick={() => void listaQuery.refetch()}>
                  tentar de novo
                </Button>
              </div>
            </div>
          ) : guests.length === 0 ? (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--ink-mute)" }}>
              <div style={{ fontFamily: FONT_HAND, fontSize: 28, color: "var(--plum)" }}>
                Sua lista ainda não possui convidados.
              </div>
            </div>
          ) : filteredGuests.length === 0 ? (
            <div style={{ padding: "48px 16px", textAlign: "center", color: "var(--ink-mute)" }}>
              <div style={{ fontFamily: FONT_HAND, fontSize: 28, color: "var(--plum)" }}>
                Nenhum resultado para o filtro selecionado.
              </div>
              <div style={{ fontFamily: FONT_SANS, fontSize: 15, color: "var(--ink-soft)", marginTop: 8 }}>
                Tente outro filtro ou adicione convidados.
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
          display: flex;
          justify-content: center;
          padding: 16px;
          background: rgba(255, 255, 255, 0.72);
          border: 1px solid var(--line);
          border-radius: 24px;
        }
        .cv-virtual-invite-status {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 32px 16px;
          text-align: center;
          font-family: var(--font-dm-sans), sans-serif;
          font-size: 14px;
          color: var(--ink-soft);
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
      {verLinkOpen && (
        <VerLinkModal
          slug={slug}
          formatoMensagemConvite={inviteType}
          onClose={() => setVerLinkOpen(false)}
        />
      )}

      {sendTarget && (
        <EnviarConviteModal
          guest={sendTarget}
          slug={slug}
          eventTypeLabel={eventTypeLabel}
          mensagemConvite={state.message}
          onClose={() => setSendTarget(null)}
          onSent={() =>
            alterarPresenca.mutateAsync({ idConvidado: sendTarget.id, presenca: "enviado" })
          }
        />
      )}
    </section>
  );
}
