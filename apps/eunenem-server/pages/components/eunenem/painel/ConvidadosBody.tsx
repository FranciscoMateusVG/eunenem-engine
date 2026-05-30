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
  children,
}: {
  variant: BtnVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
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
    if (!n) return;
    onAdd({ name: n.toLowerCase(), phone: phone.trim() || "—" });
    setName("");
    setPhone("");
    onClose();
  };

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
            <span className="eyebrow coral">um novo mimo ♡</span>
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
                  placeholder="ex: ana clara"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
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
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
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
              disabled={!name.trim()}
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
        <Button variant="primary" onClick={() => setShowAdd(true)}>
          <IconPlus size={16} /> adicionar convidado
        </Button>
      </div>

      {showAdd && (
        <AddGuestModal onAdd={addGuest} onClose={() => setShowAdd(false)} />
      )}

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
    </section>
  );
}
