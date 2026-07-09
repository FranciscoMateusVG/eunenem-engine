import { useMemo, useState, type CSSProperties } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import { useCampanhaRota } from "@/lib/campanha-rota.js";
import { trpc } from "@/lib/trpc";

// aperture-5v766 Phase B + aperture-kih74 swap-over — admin mensagens page
// against Rex's Phase A backend (PR #199).
//
// Content-only body for /painel/:slug/mensagens. The topbar / shell / Tweaks
// come from PainelLayout — this renders ONLY the page content, matching the
// painel-body conventions established by ConvidadosBody / PresentesBody.
//
// Wire shape from `trpc.painelMensagens.list({ slug })`:
//   - idPagamento: uuid string
//   - contribuinteNome: string
//   - mensagem: string
//   - criadoEm: ISO-8601 string (parsed at render via new Date)
//   - lidaEm: ISO-8601 string | null
//   - valorContribuicaoCents: integer (BRL cents)
//   - contribuicaoNome: string | null (null when the contribuição row was
//     deleted between pagamento and read — render "(presente removido)")
//
// Slug-keyed (no idCampanha resolver needed — tenant chain runs server-side
// from session-derived idUsuario + slug verification).
//
// Type declared inline rather than derived from AppRouter via
// `inferRouterOutputs` because the engine's painel-mensagens-router has
// some relative-path noise in its src/domain imports that breaks the
// inferred-router chain in this worktree's strict tsc. The runtime call
// + wire validation are unaffected; the inline shape stays a verbatim
// mirror of `AdminRecadoProjectionSchema` exported from `src/index.ts`.
interface AdminRecadoProjection {
  idPagamento: string;
  contribuinteNome: string;
  mensagem: string;
  criadoEm: string;
  lidaEm: string | null;
  valorContribuicaoCents: number;
  contribuicaoNome: string | null;
}

// AGRADECER scope decision (aperture-5v766 spec §6):
// The button stays visible as an affordance — hiding it would erase a
// signal the operator and contribuintes both expect. On click we surface a
// sonner toast "em breve" so the affordance is honest about its stub state.
// The eventual AGRADECER path needs operator spec (P3 follow-up); when
// that ships, the toast swap becomes a real mutation.

const SHADOW_SM = "0 2px 10px rgba(107, 60, 94, 0.06)";
const SHADOW_MD = "0 14px 36px rgba(107, 60, 94, 0.1)";

const FONT_HAND = "var(--font-patrick-hand), cursive";
const FONT_CAVEAT = "var(--font-caveat), cursive";
const FONT_SANS = "var(--font-dm-sans), system-ui, sans-serif";

// ---------- avatar palette (djb2 → palette index) ----------
const AVATAR_PALETTES: readonly { bg: string; fg: string }[] = [
  { bg: "var(--lilac-soft)", fg: "var(--lilac-deep)" },
  { bg: "var(--pink-soft)", fg: "var(--coral-pink)" },
  { bg: "color-mix(in srgb, var(--green) 32%, white)", fg: "var(--green-deep)" },
  { bg: "color-mix(in srgb, var(--yellow) 35%, white)", fg: "#8a6a14" },
  { bg: "color-mix(in srgb, var(--lilac) 28%, white)", fg: "var(--plum)" },
];

/** djb2 hash → deterministic palette pick by contribuinte name. */
function avatarFor(name: string): { bg: string; fg: string } {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length] ?? AVATAR_PALETTES[0]!;
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}

function fmtCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

const REL_DIVS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];

/**
 * Relative time in pt-BR ("há 4 horas"). Falls back to "agora" under 1m.
 *
 * aperture-kih74 — accepts ISO-8601 strings (Rex's wire shape) instead of
 * Date objects. Internal Date parse stays the same.
 */
function relativeTime(iso: string): string {
  const d = new Date(iso);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "agora";
  for (const [unit, secs] of REL_DIVS) {
    if (abs >= secs) {
      return rtf.format(Math.round(seconds / secs), unit);
    }
  }
  return "agora";
}

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

// ---------- skeleton card (loading state) ----------
function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      style={{
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 22,
        padding: "18px 20px",
        display: "flex",
        gap: 14,
        boxShadow: SHADOW_SM,
        opacity: 0.7,
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          flexShrink: 0,
          borderRadius: "50%",
          background: "var(--cream-2)",
        }}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            width: "40%",
            height: 16,
            borderRadius: 6,
            background: "var(--cream-2)",
          }}
        />
        <div
          style={{
            width: "92%",
            height: 14,
            borderRadius: 6,
            background: "var(--cream-2)",
          }}
        />
        <div
          style={{
            width: "70%",
            height: 14,
            borderRadius: 6,
            background: "var(--cream-2)",
          }}
        />
      </div>
    </div>
  );
}

// ---------- recado card ----------
function RecadoCard({
  r,
  onMarcarLida,
  onAgradecer,
  isMarkingLida,
}: {
  r: AdminRecadoProjection;
  onMarcarLida: (idPagamento: string) => void;
  onAgradecer: (r: AdminRecadoProjection) => void;
  isMarkingLida: boolean;
}) {
  const pal = avatarFor(r.contribuinteNome);
  const isUnread = r.lidaEm === null;
  const firstName = r.contribuinteNome
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)[0];

  return (
    <article
      data-testid={isUnread ? undefined : "recado-lida-badge"}
      style={{
        background: isUnread
          ? "linear-gradient(135deg, var(--paper), rgba(232, 213, 240, 0.35))"
          : "var(--paper)",
        border: `1px solid ${isUnread ? "rgba(167, 123, 190, 0.4)" : "var(--line)"}`,
        borderRadius: 22,
        padding: "18px 20px",
        display: "flex",
        gap: 14,
        position: "relative",
        boxShadow: isUnread ? SHADOW_MD : SHADOW_SM,
      }}
    >
      {isUnread && (
        <span
          style={{
            position: "absolute",
            top: 12,
            right: 16,
            fontFamily: FONT_CAVEAT,
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--coral-pink)",
            transform: "rotate(-6deg)",
            pointerEvents: "none",
            textTransform: "uppercase",
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
        {initialsOf(r.contribuinteNome)}
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
            {r.contribuinteNome}
          </span>
          <span
            style={{
              fontFamily: FONT_SANS,
              fontSize: 12.5,
              color: "var(--ink-mute)",
              whiteSpace: "nowrap",
            }}
          >
            {relativeTime(r.criadoEm)}
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
          &ldquo;{r.mensagem}&rdquo;
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
          {/* gift chip — aperture-kih74: valorContribuicaoCents rename +
              null fallback for contribuicaoNome when the contribuição
              row was deleted between pagamento and read. */}
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
              {fmtCents(r.valorContribuicaoCents)}
            </strong>
            <span style={{ color: "var(--ink-mute)" }}>·</span>
            {r.contribuicaoNome ?? (
              <em style={{ color: "var(--ink-mute)" }}>(presente removido)</em>
            )}
          </span>

          {/* actions */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {isUnread && (
              <button
                type="button"
                onClick={() => onMarcarLida(r.idPagamento)}
                disabled={isMarkingLida}
                title="marcar como lida"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 14px",
                  borderRadius: 999,
                  border: "1px solid var(--line)",
                  background: "transparent",
                  color: "var(--ink-soft)",
                  cursor: isMarkingLida ? "default" : "pointer",
                  opacity: isMarkingLida ? 0.6 : 1,
                  fontFamily: FONT_SANS,
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  whiteSpace: "nowrap",
                }}
              >
                <IconCheck size={13} /> marcar lida
              </button>
            )}
            <button
              type="button"
              onClick={() => onAgradecer(r)}
              title={`agradecer ${firstName ?? ""}`}
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
export function MensagensBody({ slug }: PainelSectionBodyProps) {
  // aperture-kih74 — real wire. Slug-keyed; tenant chain runs server-side
  // (session-derived idUsuario → slug-owner-admin guard → idCampanha lookup).
  // No client-side slug→idCampanha resolver needed.
  //
  // aperture-z6vks — recados are campanha-scoped body content: pass the
  // clicked /c/:idCampanha so campanha B shows B's mensagens, not the
  // default's. Bare URL → slug-only → server default (back-compat).
  // Invalidations below use invalidate({ slug }) — react-query's partial
  // deep matching still hits the { slug, idCampanha } query key.
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaRota();
  const list = trpc.painelMensagens.list.useQuery(idCampanha ? { slug, idCampanha } : { slug });
  // Both mutations invalidate the list on success so the NOVA badge +
  // filter counts repaint in one round-trip without optimistic updates.
  const marcarLida = trpc.painelMensagens.marcarLida.useMutation({
    onSuccess: () => {
      void utils.painelMensagens.list.invalidate({ slug });
    },
  });
  const marcarTodasLidas = trpc.painelMensagens.marcarTodasLidas.useMutation({
    onSuccess: () => {
      void utils.painelMensagens.list.invalidate({ slug });
    },
  });

  const [filter, setFilter] = useState<"all" | "unread">("all");

  // Explicit type aliasing for `recados` — see file-header comment
  // explaining the AppRouter inference gap from Rex's painel-mensagens-
  // router import-path quirks. Wire shape is authoritative; the cast
  // is a contract assertion (validated at wire-input time by the same
  // AdminRecadoProjectionSchema Rex's procedure outputs).
  const recados: readonly AdminRecadoProjection[] =
    (list.data?.recados ?? []) as readonly AdminRecadoProjection[];
  const counts: { todas: number; naoLidas: number } =
    (list.data?.counts ?? { todas: 0, naoLidas: 0 }) as {
      todas: number;
      naoLidas: number;
    };

  const visible = useMemo(
    () =>
      filter === "unread"
        ? recados.filter((r) => r.lidaEm === null)
        : recados,
    [recados, filter],
  );

  const handleMarcarLida = (idPagamento: string) => {
    // aperture-1yx1n — writes target the ROUTE campanha (bare URL → server default).
    marcarLida.mutate(idCampanha ? { slug, idPagamento, idCampanha } : { slug, idPagamento });
  };

  const handleMarcarTodas = () => {
    if (!counts.naoLidas) {
      toast("nenhum recado novo por aqui ♡");
      return;
    }
    // aperture-1yx1n — writes target the ROUTE campanha (bare URL → server default).
    marcarTodasLidas.mutate(idCampanha ? { slug, idCampanha } : { slug });
    toast.success("tudo lido ♡");
  };

  const handleAgradecer = (_r: AdminRecadoProjection) => {
    // AGRADECER stub — see file-header decision. Surface affordance, no action.
    toast("agradecer — em breve ♡");
  };

  const filterChips: readonly [typeof filter, string, number][] = [
    ["all", "todas", counts.todas],
    ["unread", "não lidas", counts.naoLidas],
  ];

  const showSkeleton = list.isLoading;
  const showEmpty = !showSkeleton && visible.length === 0;

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
              {counts.todas} recados de quem presenteou o seu bebê.
            </p>
            {counts.naoLidas > 0 && (
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
                {counts.naoLidas} {counts.naoLidas === 1 ? "nova" : "novas"}
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
          onClick={handleMarcarTodas}
          disabled={!counts.naoLidas || marcarTodasLidas.isPending}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid var(--line)",
            background: "transparent",
            color: "var(--ink-soft)",
            cursor:
              counts.naoLidas && !marcarTodasLidas.isPending
                ? "pointer"
                : "default",
            opacity: counts.naoLidas ? 1 : 0.5,
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
        {showSkeleton ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : showEmpty ? (
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
              {filter === "unread"
                ? "nenhum recado novo ♡"
                : "ainda sem recados ♡"}
            </div>
            <div
              style={{
                fontFamily: FONT_SANS,
                fontSize: 15,
                color: "var(--ink-soft)",
                marginTop: 8,
              }}
            >
              {filter === "unread"
                ? 'você já leu todos os carinhos. veja todas em "todas".'
                : "assim que alguém presentear com uma mensagem, ela aparece aqui."}
            </div>
          </div>
        ) : (
          visible.map((r) => (
            <RecadoCard
              key={r.idPagamento}
              r={r}
              onMarcarLida={handleMarcarLida}
              onAgradecer={handleAgradecer}
              isMarkingLida={marcarLida.isPending}
            />
          ))
        )}
      </div>
    </section>
  );
}
