import { useState } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  countdownTo,
  DEFAULT_STATE,
  EVENT_BY_ID,
  EVENT_TYPES,
  formatDateScrap,
  NAME_FONT_BY_ID,
  NAME_FONTS,
  PALETTE_BY_ID,
  PALETTES,
  type ConviteState,
  type Density,
  type Fidelity,
  type Palette,
  type PreviewFormat,
} from "@/lib/mocks/convite";

// aperture-q8rr — Convites: the invite-builder wizard for /painel/:slug/convite.
//
// CONTENT ONLY — the painel topbar / sidebar / shell come from PainelLayout.
// Ported from the "Convites Desktop" + "Convites Mobile" exports into the
// painel foundation. The interaction model is the dual-pane live-preview
// wizard (Direction A): a scrollable scrapbook form on the left whose every
// keystroke re-renders the invite card on the right, in real time. On narrow
// screens it collapses to a sticky preview hero on top of the form, plus a
// tap-to-expand fullscreen sheet (the Convites Mobile pattern).
//
// Mock-first: "enviar" / "baixar" / the ✦ copy-suggest buttons fire a sonner
// toast and mutate local state; nothing persists. The preview ships two
// asset-free fidelities — scrapbook (caderninho, default) + clean (tipográfico
// minimalista). The export's watercolor-template and photo-upload modes need
// PNG assets this repo doesn't carry, so they're intentionally out of scope.
//
// Styling is a scoped <style> block (cv- prefix) reusing the shared design
// tokens from tailwind.css; the few export-only shades not in the token set
// (--cv-line-strong etc.) are declared locally on .cv.

// ── canned copy suggestions (mock — replaces the export's AI calls) ─────────

const SUGGEST: Record<string, { message: string; hashtag: string }> = {
  "cha-bebe": {
    message:
      "a gente já te ama tanto. vem celebrar com a gente essa nova fase, prometemos café e mimos ♡",
    hashtag: "#chegadaDaMari",
  },
  "cha-fraldas": {
    message:
      "tá quase na hora! vem nos ajudar a deixar tudo pronto pra chegada. promessa de brigadeiro ♡",
    hashtag: "#cháDeFraldas",
  },
  "cha-surpresa": {
    message:
      "a gente preparou tudo no maior segredo. cola sem avisar — só com sorriso no rosto ♡",
    hashtag: "#surpresinha",
  },
  batizado: {
    message:
      "queremos dividir esse dia tão especial com quem caminha junto da gente desde o começo ♡",
    hashtag: "#batizado",
  },
  "cha-revelacao": {
    message:
      "a gente sabe — mas só vai contar lá. vem descobrir com a gente em meio a balões e abraços ♡",
    hashtag: "#vaiSerOQue",
  },
  aniversario: {
    message:
      "mais um ano que a gente quer celebrar com gente boa, comida boa e abraço apertado ♡",
    hashtag: "#maisUmAno",
  },
};

// ── tiny inline icons ───────────────────────────────────────────────────────

function Sparkle() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
      <path d="M5.5 0L6.6 4.4 11 5.5 6.6 6.6 5.5 11 4.4 6.6 0 5.5 4.4 4.4z" />
    </svg>
  );
}

function previewScale(format: PreviewFormat, ctx: "pane" | "hero" | "modal"): number {
  const table: Record<typeof ctx, Record<PreviewFormat, number>> = {
    pane: { story: 0.85, square: 0.78, link: 0.72 },
    hero: { story: 0.5, square: 0.46, link: 0.5 },
    modal: { story: 0.92, square: 0.82, link: 0.74 },
  };
  return table[ctx][format];
}

// ════════════════════════════════════════════════════════════════════════════
// Live invite preview — scrapbook (default) + clean modes.
// ════════════════════════════════════════════════════════════════════════════

interface PreviewProps {
  state: ConviteState;
  format: PreviewFormat;
  fidelity: Fidelity;
  scale: number;
}

const DIMS: Record<PreviewFormat, { w: number; h: number }> = {
  story: { w: 400, h: 600 },
  square: { w: 480, h: 480 },
  link: { w: 540, h: 360 },
};

function InvitePreview({ state, format, fidelity, scale }: PreviewProps) {
  const ev = EVENT_BY_ID[state.eventType] ?? EVENT_TYPES[0]!;
  const pal = PALETTE_BY_ID[state.palette] ?? PALETTES[0]!;
  const date = formatDateScrap(state.date);
  const nameFontCss = (NAME_FONT_BY_ID[state.nameFont] ?? NAME_FONTS[0]!).css;
  const isOnline = state.mode === "online";
  const cd = isOnline ? countdownTo(state.date, state.time) : null;
  const dims = DIMS[format];

  if (fidelity === "clean") {
    return (
      <CleanInvite
        state={state}
        dims={dims}
        scale={scale}
        pal={pal}
        evLabel={ev.label}
        date={date}
        isOnline={isOnline}
        cd={cd}
        nameFontCss={nameFontCss}
        format={format}
      />
    );
  }
  return (
    <ScrapbookInvite
      state={state}
      dims={dims}
      scale={scale}
      pal={pal}
      evLabel={ev.label}
      evHint={ev.emojiHint}
      evIcon={ev.icon}
      date={date}
      isOnline={isOnline}
      cd={cd}
      nameFontCss={nameFontCss}
      format={format}
    />
  );
}

interface ModeProps {
  state: ConviteState;
  dims: { w: number; h: number };
  scale: number;
  pal: Palette;
  evLabel: string;
  date: ReturnType<typeof formatDateScrap>;
  isOnline: boolean;
  cd: ReturnType<typeof countdownTo>;
  nameFontCss: string;
  format: PreviewFormat;
}

function ScrapbookInvite({
  state,
  dims,
  scale,
  pal,
  evLabel,
  evHint,
  evIcon,
  date,
  isOnline,
  cd,
  nameFontCss,
  format,
}: ModeProps & { evHint: string; evIcon: string }) {
  const decorOpacity = { pouca: 0.4, media: 1, muita: 1.6 }[state.density as Density] ?? 1;
  return (
    <div
      style={{
        width: dims.w * scale,
        height: dims.h * scale,
        position: "relative",
        overflow: "hidden",
        background: "#FFFCF8",
        borderRadius: 14 * scale,
        boxShadow:
          "0 1px 0 rgba(107,60,94,.06), 0 8px 24px rgba(107,60,94,.16)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          width: dims.w,
          height: dims.h,
        }}
      >
        {/* paper wash */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(at 15% 12%, ${pal.soft}cc 0, transparent 45%), radial-gradient(at 88% 88%, ${pal.primary}55 0, transparent 50%), radial-gradient(at 90% 10%, ${pal.accent}33 0, transparent 35%)`,
          }}
        />
        {/* dot grain */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "radial-gradient(rgba(107,60,94,.04) 1px, transparent 1px)",
            backgroundSize: "12px 12px",
          }}
        />
        {/* washi tape */}
        {state.density !== "pouca" && (
          <div
            style={{
              position: "absolute",
              top: 14,
              left: "50%",
              width: 90,
              height: 22,
              transform: "translateX(-50%) rotate(-3deg)",
              background: `repeating-linear-gradient(45deg, rgba(255,255,255,.45) 0, rgba(255,255,255,.45) 4px, transparent 4px, transparent 9px), ${pal.primary}`,
              opacity: 0.85 * decorOpacity,
              boxShadow: "0 1px 3px rgba(107,60,94,.15)",
            }}
          />
        )}
        {/* eyebrow */}
        <div
          style={{
            position: "absolute",
            top: 50,
            left: 24,
            fontFamily: "var(--font-caveat), cursive",
            fontSize: 21,
            color: "#7A5A6C",
            transform: "rotate(-3deg)",
          }}
        >
          <span
            style={{
              background: `linear-gradient(180deg, transparent 0 60%, ${pal.accent}88 60% 92%, transparent 92%)`,
              padding: "0 4px",
            }}
          >
            {evLabel}
          </span>{" "}
          {evHint.split(" ")[0]}
        </div>
        {/* baby name */}
        <div
          style={{
            position: "absolute",
            top: format === "link" ? 90 : 95,
            left: 24,
            right: 24,
            fontFamily: nameFontCss,
            color: pal.ink,
            fontSize: format === "square" ? 60 : format === "link" ? 52 : 64,
            lineHeight: 0.95,
            letterSpacing: "-0.01em",
            textWrap: "pretty",
          }}
        >
          {state.babyName || (state.eventType === "aniversario" ? "Mariana" : "Maria Helena")}
        </div>
        {/* polaroid */}
        {state.density === "muita" && format !== "link" && (
          <div
            style={{
              position: "absolute",
              top: 185,
              right: 18,
              width: 86,
              height: 100,
              background: "white",
              padding: "6px 6px 18px",
              transform: "rotate(5deg)",
              boxShadow: "0 6px 14px rgba(107,60,94,.18)",
              border: "1px solid #f0e2e9",
            }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                background: `linear-gradient(135deg, ${pal.soft}, ${pal.primary}88)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 24,
              }}
            >
              {evIcon}
            </div>
          </div>
        )}
        {/* date / online */}
        {isOnline ? (
          <div style={{ position: "absolute", top: format === "link" ? 170 : 200, left: 24, right: 24 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 22,
                color: pal.deep,
                border: `1.6px solid ${pal.deep}`,
                borderRadius: 999,
                padding: "2px 14px 4px",
                transform: "rotate(-4deg)",
                background: "rgba(255,255,255,.55)",
                marginBottom: 14,
              }}
            >
              evento online ♡
            </div>
            {cd && (
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                {([["dias", cd.days], ["h", cd.hours], ["min", cd.mins]] as const).map(
                  ([l, v], i) => (
                    <div
                      key={l}
                      style={{
                        background: "white",
                        border: "1px solid #efe2e9",
                        borderRadius: 12,
                        padding: "8px 10px",
                        textAlign: "center",
                        minWidth: 52,
                        boxShadow: "0 2px 6px rgba(107,60,94,.08)",
                        transform: `rotate(${[-2, -1, 1][i]}deg)`,
                        fontFamily: "var(--font-patrick-hand), cursive",
                      }}
                    >
                      <div style={{ fontSize: 26, color: pal.ink, lineHeight: 1 }}>
                        {String(v).padStart(2, "0")}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: "var(--font-dm-sans), sans-serif",
                          textTransform: "uppercase",
                          letterSpacing: ".1em",
                          color: "#A18A99",
                          marginTop: 2,
                        }}
                      >
                        {l}
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
            {state.onlineLink && (
              <div
                style={{
                  marginTop: 10,
                  fontFamily: "var(--font-dm-sans), sans-serif",
                  fontSize: 10.5,
                  color: "#5C3A4F",
                  letterSpacing: ".04em",
                  wordBreak: "break-all",
                  maxWidth: 280,
                }}
              >
                {state.onlineLink}
              </div>
            )}
          </div>
        ) : (
          <div style={{ position: "absolute", top: format === "link" ? 170 : 210, left: 24, right: 24 }}>
            {date && (
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <span
                  style={{
                    fontFamily: "var(--font-patrick-hand), cursive",
                    fontSize: 46,
                    color: pal.ink,
                    lineHeight: 1,
                  }}
                >
                  {date.day}
                </span>
                <div
                  style={{
                    fontFamily: "var(--font-caveat), cursive",
                    fontSize: 22,
                    color: pal.deep,
                    lineHeight: 1.1,
                  }}
                >
                  <div>{date.monthFull}</div>
                  <div style={{ fontSize: 16, color: "#7A5A6C" }}>{date.weekday}</div>
                </div>
              </div>
            )}
            {state.time && (
              <div style={{ fontFamily: "var(--font-patrick-hand), cursive", fontSize: 22, color: pal.ink }}>
                às{" "}
                <span
                  style={{
                    background: `linear-gradient(180deg, transparent 0 60%, ${pal.accent}88 60% 92%, transparent 92%)`,
                    padding: "0 4px",
                  }}
                >
                  {state.time}
                </span>
              </div>
            )}
            {state.address && (
              <div
                style={{
                  marginTop: 12,
                  fontFamily: "var(--font-patrick-hand), cursive",
                  fontSize: 17,
                  color: "#5C3A4F",
                  lineHeight: 1.25,
                  paddingLeft: 12,
                  borderLeft: `2px dashed ${pal.primary}`,
                  maxWidth: 320,
                  whiteSpace: "pre-line",
                }}
              >
                {state.address}
              </div>
            )}
          </div>
        )}
        {/* footer */}
        <div
          style={{
            position: "absolute",
            bottom: 18,
            left: 24,
            right: 24,
            fontFamily: "var(--font-patrick-hand), cursive",
            color: "#5C3A4F",
          }}
        >
          {state.message && (
            <div
              style={{
                fontSize: 15,
                lineHeight: 1.35,
                marginBottom: 10,
                fontStyle: "italic",
                color: "#6B3C5E",
                textWrap: "pretty",
              }}
            >
              {state.message}
            </div>
          )}
          {state.host && (
            <div
              style={{
                fontFamily: "var(--font-caveat), cursive",
                fontSize: 20,
                color: pal.deep,
                transform: "rotate(-2deg)",
                transformOrigin: "left bottom",
                display: "inline-block",
              }}
            >
              com amor, {state.host}
            </div>
          )}
          {state.hashtag && state.showHashtag && (
            <div
              style={{
                marginTop: 6,
                fontFamily: "var(--font-dm-sans), sans-serif",
                fontSize: 11,
                color: pal.deep,
                letterSpacing: ".04em",
              }}
            >
              {state.hashtag}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CleanInvite({
  state,
  dims,
  scale,
  pal,
  evLabel,
  date,
  isOnline,
  cd,
  nameFontCss,
  format,
}: ModeProps) {
  return (
    <div
      style={{
        width: dims.w * scale,
        height: dims.h * scale,
        position: "relative",
        overflow: "hidden",
        background: pal.soft,
        borderRadius: 14 * scale,
        boxShadow: "0 1px 0 rgba(107,60,94,.06), 0 8px 24px rgba(107,60,94,.16)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          width: dims.w,
          height: dims.h,
          padding: "40px 36px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 20,
            left: 20,
            right: 20,
            bottom: 20,
            border: `1px solid ${pal.deep}55`,
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-dm-sans), sans-serif",
            fontSize: 10,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: pal.deep,
            textAlign: "center",
            marginTop: 14,
          }}
        >
          {evLabel}
        </div>
        <div
          style={{
            fontFamily: nameFontCss,
            color: pal.ink,
            fontSize: format === "square" ? 56 : format === "link" ? 44 : 56,
            lineHeight: 1,
            textAlign: "center",
            marginTop: format === "link" ? 14 : 32,
            letterSpacing: "-0.005em",
            textWrap: "pretty",
          }}
        >
          {state.babyName || "Maria Helena"}
        </div>
        <div style={{ width: 36, height: 1, background: pal.deep, margin: "20px auto" }} />
        {isOnline ? (
          <div style={{ textAlign: "center", flex: 1 }}>
            <div
              style={{
                display: "inline-block",
                fontFamily: "var(--font-dm-sans), sans-serif",
                fontSize: 9,
                letterSpacing: ".2em",
                textTransform: "uppercase",
                color: pal.deep,
                border: `1px solid ${pal.deep}`,
                padding: "4px 10px",
                marginBottom: 18,
              }}
            >
              evento online
            </div>
            {cd && (
              <div style={{ display: "flex", justifyContent: "center", gap: 16 }}>
                {([["DIAS", cd.days], ["HORAS", cd.hours], ["MIN", cd.mins]] as const).map(
                  ([l, v]) => (
                    <div key={l}>
                      <div style={{ fontFamily: nameFontCss, fontSize: 30, color: pal.ink, lineHeight: 1 }}>
                        {String(v).padStart(2, "0")}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--font-dm-sans), sans-serif",
                          fontSize: 8,
                          letterSpacing: ".18em",
                          color: pal.deep,
                          marginTop: 2,
                        }}
                      >
                        {l}
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
            {state.onlineLink && (
              <div
                style={{
                  fontFamily: "var(--font-dm-sans), sans-serif",
                  fontSize: 10,
                  color: pal.deep,
                  marginTop: 16,
                  wordBreak: "break-all",
                  padding: "0 16px",
                }}
              >
                {state.onlineLink}
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: "center", flex: 1 }}>
            {date && (
              <div>
                <div style={{ fontFamily: nameFontCss, fontSize: 30, color: pal.ink, lineHeight: 1 }}>
                  {date.day} {date.monthFull}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-dm-sans), sans-serif",
                    fontSize: 10,
                    letterSpacing: ".18em",
                    textTransform: "uppercase",
                    color: pal.deep,
                    marginTop: 6,
                  }}
                >
                  {date.weekday}
                  {state.time ? ` · ${state.time}` : ""}
                </div>
              </div>
            )}
            {state.address && (
              <div
                style={{
                  fontFamily: "var(--font-dm-sans), sans-serif",
                  fontSize: 11,
                  color: pal.ink,
                  marginTop: 18,
                  padding: "0 24px",
                  lineHeight: 1.55,
                  textWrap: "pretty",
                  whiteSpace: "pre-line",
                }}
              >
                {state.address}
              </div>
            )}
          </div>
        )}
        {state.message && (
          <div
            style={{
              fontFamily: "var(--font-dm-sans), sans-serif",
              fontStyle: "italic",
              fontSize: 11,
              color: pal.ink,
              textAlign: "center",
              lineHeight: 1.55,
              padding: "0 24px",
              marginTop: "auto",
              textWrap: "pretty",
            }}
          >
            &ldquo;{state.message}&rdquo;
          </div>
        )}
        <div
          style={{
            fontFamily: "var(--font-dm-sans), sans-serif",
            fontSize: 9,
            letterSpacing: ".22em",
            textTransform: "uppercase",
            color: pal.deep,
            textAlign: "center",
            marginTop: 14,
          }}
        >
          {state.host || "os pais"}
          {state.hashtag && state.showHashtag ? ` · ${state.hashtag}` : ""}
        </div>
      </div>
    </div>
  );
}

// ── small form primitives ───────────────────────────────────────────────────

function FormCard({
  step,
  title,
  rightSlot,
  children,
}: {
  step: string;
  title: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="cv-card">
      <div className="cv-card-head">
        <div className="cv-step">{step}</div>
        <div className="cv-card-title">{title}</div>
        <div style={{ flex: 1 }} />
        {rightSlot}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  sub,
  on,
  onToggle,
}: {
  label: string;
  sub?: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="cv-toggle-row">
      <button
        type="button"
        className={`cv-switch ${on ? "on" : ""}`}
        onClick={onToggle}
        role="switch"
        aria-checked={on}
        aria-label={label}
      >
        <span className="cv-knob" />
      </button>
      <div style={{ flex: 1 }}>
        <div className="cv-toggle-label">{label}</div>
        {sub && <div className="cv-toggle-sub">{sub}</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ConviteBody
// ════════════════════════════════════════════════════════════════════════════

export function ConviteBody(_props: PainelSectionBodyProps) {
  const [state, setState] = useState<ConviteState>({ ...DEFAULT_STATE });
  const [format, setFormat] = useState<PreviewFormat>("story");
  const [fidelity, setFidelity] = useState<Fidelity>("scrapbook");
  const [showExtras, setShowExtras] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const update = <K extends keyof ConviteState>(k: K, v: ConviteState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const ev = EVENT_BY_ID[state.eventType] ?? EVENT_TYPES[0]!;

  const suggestCopy = () => {
    const s = SUGGEST[state.eventType] ?? SUGGEST["cha-bebe"]!;
    setState((prev) => ({ ...prev, message: s.message, hashtag: s.hashtag }));
    toast.success("escrevemos uma sugestão pra você ♡");
  };

  const onSend = () => toast.success("convite pronto! agora é só compartilhar ♡");
  const onSaveDraft = () => toast.success("rascunho salvo com carinho ♡");
  const onDownloadAll = () => toast.success("seus 3 formatos foram gerados ♡");

  const nameLabel =
    ev.id === "aniversario"
      ? "de quem é o dia?"
      : ev.id === "batizado"
        ? "nome do(a) batizando(a)"
        : "nome do bebê";

  const formatTabs = (
    <div className="cv-seg" role="tablist" aria-label="formato do convite">
      {(
        [
          ["story", "story"],
          ["square", "quadrado"],
          ["link", "link"],
        ] as const
      ).map(([k, l]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={format === k}
          className={format === k ? "on" : ""}
          onClick={() => setFormat(k)}
        >
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div className="cv">
      <style>{CV_CSS}</style>

      {/* heading */}
      <header className="cv-head">
        <span className="cv-eyebrow">um novo mimo ♡</span>
        <h1>
          vamos criar seu <span className="hl">convite</span>
        </h1>
        <p>
          preencha pouquinho por vez — o preview já vai se ajustando ao lado. quando travar na
          escrita, o ✦ dá uma mãozinha ♡
        </p>
      </header>

      <div className="cv-shell">
        {/* ── FORM (left on desktop) ── */}
        <div className="cv-form">
          <FormCard step="1" title="que mimo é esse?">
            <div className="cv-event-grid">
              {EVENT_TYPES.map((e, i) => {
                const on = state.eventType === e.id;
                return (
                  <button
                    key={e.id}
                    type="button"
                    className={`cv-event ${on ? "on" : ""}`}
                    style={{ transform: `rotate(${[-1.5, 0.5, -0.8, 1, -0.4, 0.8][i]}deg)` }}
                    onClick={() => update("eventType", e.id)}
                    aria-pressed={on}
                  >
                    <span className="cv-event-ico">{e.icon}</span>
                    <span className="cv-event-label">{e.label}</span>
                  </button>
                );
              })}
            </div>
          </FormCard>

          <FormCard step="2" title={nameLabel}>
            <label className="cv-label">nome</label>
            <input
              className="cv-input"
              value={state.babyName}
              onChange={(e) => update("babyName", e.target.value)}
              placeholder="Maria Helena, Pedro, …"
              aria-label="nome"
            />
            <div style={{ height: 14 }} />
            <label className="cv-label" style={{ transform: "rotate(1deg)" }}>
              de quem vem o convite
            </label>
            <input
              className="cv-input"
              value={state.host}
              onChange={(e) => update("host", e.target.value)}
              placeholder="Mariana & Tiago"
              aria-label="de quem vem o convite"
            />
          </FormCard>

          <FormCard step="3" title="quando e onde?">
            <div className="cv-seg" style={{ marginBottom: 14 }}>
              <button
                type="button"
                className={state.mode === "presencial" ? "on" : ""}
                onClick={() => update("mode", "presencial")}
              >
                presencial
              </button>
              <button
                type="button"
                className={state.mode === "online" ? "on" : ""}
                onClick={() => update("mode", "online")}
              >
                só online
              </button>
            </div>

            {state.mode === "online" && (
              <div className="cv-note">
                ✨ você pode deixar a data em branco — o convite só mostra o link e um countdown
                opcional.
              </div>
            )}

            <div className="cv-grid-2" style={{ marginBottom: 12 }}>
              <div>
                <label className="cv-label">
                  data{" "}
                  {state.mode === "online" && <span className="cv-opt">(opcional)</span>}
                </label>
                <input
                  className="cv-input"
                  type="date"
                  value={state.date}
                  onChange={(e) => update("date", e.target.value)}
                  aria-label="data"
                />
              </div>
              <div>
                <label className="cv-label" style={{ transform: "rotate(1deg)" }}>
                  horário{" "}
                  {state.mode === "online" && <span className="cv-opt">(opcional)</span>}
                </label>
                <input
                  className="cv-input"
                  type="time"
                  value={state.time}
                  onChange={(e) => update("time", e.target.value)}
                  aria-label="horário"
                />
              </div>
            </div>

            {state.mode === "presencial" ? (
              <>
                <label className="cv-label">endereço</label>
                <textarea
                  className="cv-textarea"
                  rows={2}
                  value={state.address}
                  onChange={(e) => update("address", e.target.value)}
                  placeholder="Rua, número, bairro, cidade"
                  aria-label="endereço"
                />
              </>
            ) : (
              <>
                <label className="cv-label">link da sala</label>
                <input
                  className="cv-input"
                  value={state.onlineLink}
                  onChange={(e) => update("onlineLink", e.target.value)}
                  placeholder="meet.google.com/abc-xyz"
                  aria-label="link da sala"
                />
              </>
            )}
          </FormCard>

          <FormCard
            step="4"
            title="mensagem do convite"
            rightSlot={
              <button type="button" className="cv-pill" onClick={suggestCopy}>
                <Sparkle /> pedir ajuda
              </button>
            }
          >
            <textarea
              className="cv-textarea"
              rows={3}
              value={state.message}
              onChange={(e) => update("message", e.target.value)}
              placeholder="a gente já te ama tanto…"
              aria-label="mensagem do convite"
            />
          </FormCard>

          <FormCard step="5" title="a cara do convite">
            <label className="cv-label">paleta</label>
            <div className="cv-swatches">
              {PALETTES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`cv-swatch ${state.palette === p.id ? "on" : ""}`}
                  title={p.label}
                  aria-label={`paleta ${p.label}`}
                  aria-pressed={state.palette === p.id}
                  onClick={() => update("palette", p.id)}
                  style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.deep})` }}
                />
              ))}
              <button
                type="button"
                className="cv-swatch surprise"
                title="surpreenda-me"
                aria-label="paleta surpresa"
                onClick={() =>
                  update("palette", PALETTES[Math.floor(Math.random() * PALETTES.length)]!.id)
                }
              />
              <span className="cv-swatch-name">{PALETTE_BY_ID[state.palette]?.label}</span>
            </div>

            <hr className="cv-dotline" />

            <label className="cv-label">estilo</label>
            <div className="cv-seg">
              <button
                type="button"
                className={fidelity === "scrapbook" ? "on" : ""}
                onClick={() => setFidelity("scrapbook")}
              >
                scrapbook
              </button>
              <button
                type="button"
                className={fidelity === "clean" ? "on" : ""}
                onClick={() => setFidelity("clean")}
              >
                limpo
              </button>
            </div>

            <hr className="cv-dotline" />

            <label className="cv-label">fonte do nome</label>
            <div className="cv-fonts">
              {NAME_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`cv-font ${state.nameFont === f.id ? "on" : ""}`}
                  style={{ fontFamily: f.css }}
                  onClick={() => update("nameFont", f.id)}
                  aria-pressed={state.nameFont === f.id}
                >
                  {state.babyName.split(" ")[0] || f.label}
                </button>
              ))}
            </div>

            <hr className="cv-dotline" />

            <label className="cv-label">decoração</label>
            <div className="cv-seg">
              {(["pouca", "media", "muita"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={state.density === d ? "on" : ""}
                  onClick={() => update("density", d)}
                >
                  {d === "media" ? "média" : d}
                </button>
              ))}
            </div>
          </FormCard>

          <FormCard
            step="+"
            title="mais detalhinhos"
            rightSlot={
              <button type="button" className="cv-pill" onClick={() => setShowExtras((v) => !v)}>
                {showExtras ? "recolher" : "expandir"}
              </button>
            }
          >
            {showExtras && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <ToggleRow
                  label="lista de presentes / chá de fraldas"
                  sub="vamos sugerir tamanhos pp/p/m/g"
                  on={state.gifts}
                  onToggle={() => update("gifts", !state.gifts)}
                />
                <ToggleRow
                  label="confirmar presença (rsvp)"
                  sub="os convidados respondem no link"
                  on={state.rsvp}
                  onToggle={() => update("rsvp", !state.rsvp)}
                />
                <ToggleRow
                  label="mostrar hashtag no convite"
                  sub="aparece no rodapé do card"
                  on={state.showHashtag}
                  onToggle={() => update("showHashtag", !state.showHashtag)}
                />
                <div>
                  <label className="cv-label">hashtag do evento</label>
                  <input
                    className="cv-input"
                    value={state.hashtag}
                    onChange={(e) => update("hashtag", e.target.value)}
                    placeholder="#chegadaDaMari"
                    aria-label="hashtag do evento"
                  />
                </div>
              </div>
            )}
          </FormCard>
        </div>

        {/* ── PREVIEW (right on desktop, hero on mobile) ── */}
        <div className="cv-preview-pane">
          <div className="cv-preview-sticky">
            <div className="cv-preview-head">
              <div>
                <span className="cv-eyebrow sm">é assim que vão ver ♡</span>
                <h2>preview ao vivo</h2>
              </div>
              <div style={{ flex: 1 }} />
              {formatTabs}
            </div>

            <div className="cv-preview-stage">
              <button
                type="button"
                className="cv-preview-card"
                onClick={() => setExpanded(true)}
                aria-label="ampliar preview"
              >
                <span className="cv-tape" aria-hidden="true" />
                <InvitePreview
                  state={state}
                  format={format}
                  fidelity={fidelity}
                  scale={previewScale(format, "pane")}
                />
                <span className="cv-expand-badge" aria-hidden="true">
                  ⤢
                </span>
              </button>
            </div>

            <div className="cv-preview-foot">
              <div>
                <div className="cv-foot-script">tudo pronto ↓</div>
                <div className="cv-foot-sub">3 formatos gerados</div>
              </div>
              <button type="button" className="cv-btn ghost sm" onClick={onSaveDraft}>
                salvar rascunho
              </button>
              <button type="button" className="cv-btn primary sm" onClick={onDownloadAll}>
                baixar tudo
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* sticky mobile CTA */}
      <div className="cv-mobile-cta">
        <button type="button" className="cv-btn ghost" onClick={() => setExpanded(true)}>
          ver convite ♡
        </button>
        <button type="button" className="cv-btn coral" onClick={onSend}>
          enviar convite →
        </button>
      </div>

      {/* expand modal */}
      {expanded && (
        <div
          className="cv-modal"
          role="dialog"
          aria-modal="true"
          aria-label="preview do convite"
          onClick={() => setExpanded(false)}
        >
          <div className="cv-modal-bar">
            <span className="cv-modal-title">seu convite ♡</span>
            <div style={{ flex: 1 }} />
            <div onClick={(e) => e.stopPropagation()}>{formatTabs}</div>
            <button
              type="button"
              className="cv-modal-close"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(false);
              }}
              aria-label="fechar"
            >
              ×
            </button>
          </div>
          <div className="cv-modal-stage" onClick={(e) => e.stopPropagation()}>
            <div className="cv-modal-card">
              <span className="cv-tape" aria-hidden="true" />
              <InvitePreview
                state={state}
                format={format}
                fidelity={fidelity}
                scale={previewScale(format, "modal")}
              />
            </div>
          </div>
          <div className="cv-modal-foot" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="cv-btn ghost" onClick={onSaveDraft}>
              copiar link
            </button>
            <button type="button" className="cv-btn primary" onClick={onDownloadAll}>
              baixar ↓
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── scoped CSS (cv- prefix) — reuses tailwind.css tokens ─────────────────────

const CV_CSS = `
.cv{--cv-line-strong:#e2cfd8;--cv-paper:#fffcf8}
.cv *{box-sizing:border-box}

.cv-head{margin:2px 2px 18px}
.cv-eyebrow{font-family:var(--font-caveat),cursive;color:var(--ink-soft);font-size:19px;letter-spacing:.01em;transform:rotate(-3deg);display:inline-block;transform-origin:left bottom}
.cv-eyebrow.sm{font-size:16px}
.cv-head h1{font-family:var(--font-patrick-hand),cursive;font-size:40px;color:var(--plum);margin:6px 0 4px;line-height:1;letter-spacing:-.01em;font-weight:600}
.cv-head .hl{background:linear-gradient(180deg,transparent 0,transparent 58%,var(--yellow) 58%,var(--yellow) 94%,transparent 94%);padding:0 4px}
.cv-head p{font-family:var(--font-dm-sans),sans-serif;font-size:13.5px;color:var(--ink-soft);margin:4px 0 0;max-width:460px;line-height:1.5}

/* shell — single column on mobile, dual-pane on desktop */
.cv-shell{display:grid;grid-template-columns:1fr;gap:20px}
.cv-form{order:2;display:flex;flex-direction:column;gap:16px;min-width:0}
.cv-preview-pane{order:1;min-width:0}
@media (min-width:1040px){
  .cv-shell{grid-template-columns:minmax(0,1fr) minmax(380px,430px);align-items:start}
  .cv-form{order:1}
  .cv-preview-pane{order:2}
}

/* form cards */
.cv-card{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:16px 18px 18px;box-shadow:var(--shadow-sm);position:relative}
.cv-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.cv-step{width:28px;height:28px;border-radius:50%;background:var(--cream-2);color:var(--plum);display:flex;align-items:center;justify-content:center;font-family:var(--font-patrick-hand),cursive;font-size:17px;line-height:1;transform:rotate(-4deg);border:1.5px dashed var(--cv-line-strong);flex:0 0 auto}
.cv-card-title{font-family:var(--font-patrick-hand),cursive;font-size:22px;color:var(--plum);line-height:1}

.cv-label{display:block;font-family:var(--font-caveat),cursive;font-size:21px;color:var(--plum);letter-spacing:.005em;line-height:1;margin:0 0 6px 4px;transform:rotate(-2deg);transform-origin:left bottom}
.cv-opt{font-size:12px;font-family:var(--font-dm-sans),sans-serif;color:var(--ink-mute)}

.cv-input{width:100%;font-family:var(--font-patrick-hand),cursive;font-size:22px;color:var(--ink);background:transparent;border:none;border-bottom:1.5px dashed var(--cv-line-strong);padding:6px 4px 8px;outline:none;transition:border-color .15s}
.cv-input::placeholder{color:var(--ink-mute);font-style:italic}
.cv-input:focus{border-bottom-color:var(--lilac-deep);border-bottom-style:solid}

.cv-textarea{width:100%;font-family:var(--font-patrick-hand),cursive;font-size:19px;line-height:1.45;color:var(--ink);background:rgba(255,255,255,.5);border:1px solid var(--line);border-radius:10px;padding:10px 12px;outline:none;resize:vertical;min-height:64px}
.cv-textarea:focus{border-color:var(--lilac)}

.cv-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}

.cv-note{background:var(--lilac-soft);border:1px dashed var(--lilac);border-radius:12px;padding:10px 12px;margin-bottom:14px;font-family:var(--font-caveat),cursive;font-size:17px;color:var(--plum);line-height:1.3}

/* event grid */
.cv-event-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px}
.cv-event{border:1px dashed var(--cv-line-strong);background:#fff;border-radius:14px;padding:12px 8px 10px;cursor:pointer;font-family:var(--font-patrick-hand),cursive;text-align:center;transition:all .15s ease;display:flex;flex-direction:column;align-items:center;gap:4px}
.cv-event:hover{border-color:var(--lilac)}
.cv-event.on{border:1.5px solid var(--lilac-deep);background:var(--lilac-soft);box-shadow:var(--shadow-sm)}
.cv-event-ico{font-size:26px;line-height:1}
.cv-event-label{font-size:15px;color:var(--ink);line-height:1.1}
.cv-event.on .cv-event-label{color:var(--plum)}

/* segmented */
.cv-seg{display:inline-flex;background:var(--cream-2);padding:4px;border-radius:999px;gap:2px}
.cv-seg button{border:none;background:transparent;font-family:var(--font-dm-sans),sans-serif;font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);padding:7px 14px;border-radius:999px;cursor:pointer;transition:all .15s}
.cv-seg button.on{background:#fff;color:var(--plum);box-shadow:0 1px 3px rgba(107,60,94,.12)}

/* ai pill */
.cv-pill{display:inline-flex;align-items:center;gap:5px;background:linear-gradient(135deg,var(--lilac-soft),#fff);border:1px solid var(--lilac);color:var(--lilac-deep);font-family:var(--font-dm-sans),sans-serif;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:5px 11px;border-radius:999px;cursor:pointer;transition:all .15s}
.cv-pill:hover{background:var(--lilac);color:#fff}

/* swatches */
.cv-swatches{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.cv-swatch{width:36px;height:36px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 0 0 1.5px var(--cv-line-strong);cursor:pointer;transition:transform .15s;padding:0}
.cv-swatch:hover{transform:scale(1.08)}
.cv-swatch.on{box-shadow:0 0 0 2.5px var(--plum)}
.cv-swatch.surprise{background:conic-gradient(from 0deg,var(--lilac),var(--coral-pink),var(--yellow),var(--green),var(--blue),var(--lilac))}
.cv-swatch-name{font-family:var(--font-caveat),cursive;font-size:17px;color:var(--ink-soft);margin-left:4px}

.cv-dotline{height:1px;border:0;background-image:linear-gradient(to right,var(--cv-line-strong) 50%,transparent 50%);background-size:8px 1px;background-repeat:repeat-x;margin:18px 0}

/* fonts */
.cv-fonts{display:flex;gap:8px;flex-wrap:wrap}
.cv-font{border:1px solid var(--cv-line-strong);background:#fff;border-radius:12px;padding:8px 14px;cursor:pointer;font-size:22px;line-height:1;color:var(--plum)}
.cv-font.on{border:1.5px solid var(--lilac-deep);background:var(--lilac-soft)}

/* toggle row */
.cv-toggle-row{display:flex;align-items:center;gap:12px}
.cv-switch{flex:0 0 auto;width:44px;height:26px;padding:0;border-radius:999px;border:none;cursor:pointer;background:var(--cream-2);position:relative;transition:background .15s}
.cv-switch.on{background:var(--lilac);box-shadow:var(--shadow-cta)}
.cv-knob{width:20px;height:20px;border-radius:50%;background:#fff;border:1.5px solid var(--cv-line-strong);position:absolute;top:2px;left:2px;transition:left .15s}
.cv-switch.on .cv-knob{left:22px;border-color:var(--lilac-deep)}
.cv-toggle-label{font-family:var(--font-patrick-hand),cursive;font-size:18px;color:var(--ink);line-height:1.15}
.cv-toggle-sub{font-family:var(--font-dm-sans),sans-serif;font-size:11.5px;color:var(--ink-soft);margin-top:2px}

/* preview pane */
.cv-preview-sticky{background:var(--cream);border:1px solid var(--line);border-radius:20px;padding:18px;background-image:radial-gradient(at 100% 0%,rgba(232,213,240,.5) 0,transparent 45%),radial-gradient(at 0% 100%,rgba(251,224,234,.4) 0,transparent 40%)}
@media (min-width:1040px){.cv-preview-sticky{position:sticky;top:18px}}
.cv-preview-head{display:flex;align-items:flex-end;margin-bottom:14px;gap:10px}
.cv-preview-head h2{font-family:var(--font-patrick-hand),cursive;font-size:26px;color:var(--plum);margin:2px 0 0;line-height:1}
.cv-preview-stage{display:flex;align-items:center;justify-content:center;min-height:280px}
.cv-preview-card{position:relative;background:transparent;border:none;padding:0;cursor:pointer;transform:rotate(-1deg);transition:transform .2s ease}
.cv-preview-card:hover{transform:rotate(-1deg) translateY(-2px)}
.cv-tape{position:absolute;top:-8px;left:50%;transform:translateX(-50%) rotate(-3deg);width:64px;height:18px;background:repeating-linear-gradient(45deg,rgba(255,255,255,.45) 0,rgba(255,255,255,.45) 3px,transparent 3px,transparent 7px),var(--lilac-soft);box-shadow:0 1px 3px rgba(107,60,94,.15);z-index:2}
.cv-expand-badge{position:absolute;bottom:6px;right:6px;background:rgba(107,60,94,.8);color:#fff;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;backdrop-filter:blur(4px)}
.cv-preview-foot{margin-top:16px;padding:12px 14px;background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cv-foot-script{font-family:var(--font-caveat),cursive;font-size:17px;color:var(--plum);line-height:1}
.cv-foot-sub{font-family:var(--font-dm-sans),sans-serif;font-size:10px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}

/* buttons */
.cv-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;border-radius:999px;border:1px solid transparent;background:var(--lilac);color:#fff;font-family:var(--font-dm-sans),sans-serif;font-weight:600;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:transform .12s,box-shadow .15s,background .15s;box-shadow:var(--shadow-cta);white-space:nowrap}
.cv-btn:hover{transform:translateY(-1px);background:var(--lilac-deep)}
.cv-btn.sm{padding:8px 13px;font-size:11px}
.cv-btn.ghost{background:transparent;color:var(--ink);border-color:var(--cv-line-strong);box-shadow:none}
.cv-btn.ghost:hover{background:var(--cream-2);color:var(--plum)}
.cv-btn.coral{background:var(--coral-pink);box-shadow:0 8px 20px rgba(231,143,167,.4)}
.cv-btn.coral:hover{background:#d4789a}
.cv-btn.primary{margin-left:auto}

/* mobile sticky CTA — hidden on desktop (preview always visible) */
.cv-mobile-cta{position:sticky;bottom:0;margin:18px -4px 0;padding:12px 4px;display:flex;gap:10px;background:linear-gradient(180deg,transparent,var(--cream) 40%);align-items:center}
.cv-mobile-cta .cv-btn{flex:1}
@media (min-width:1040px){.cv-mobile-cta{display:none}}

/* expand modal */
.cv-modal{position:fixed;inset:0;z-index:120;background:rgba(40,24,36,.62);backdrop-filter:blur(12px);display:flex;flex-direction:column;animation:cvFade .2s ease}
@keyframes cvFade{from{opacity:0}to{opacity:1}}
.cv-modal-bar{flex:0 0 auto;padding:18px 20px 6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.cv-modal-bar .cv-seg{background:rgba(255,255,255,.15)}
.cv-modal-bar .cv-seg button{color:rgba(255,255,255,.9)}
.cv-modal-bar .cv-seg button.on{background:#fff;color:var(--plum)}
.cv-modal-title{font-family:var(--font-caveat),cursive;font-size:24px;color:#fff;transform:rotate(-3deg);display:inline-block}
.cv-modal-close{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.2);color:#fff;border:none;cursor:pointer;font-size:22px;line-height:1;display:flex;align-items:center;justify-content:center}
.cv-modal-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:8px 24px;overflow:auto}
.cv-modal-card{position:relative;transform:rotate(-1.5deg)}
.cv-modal-foot{flex:0 0 auto;padding:14px 20px 28px;display:flex;gap:10px}
.cv-modal-foot .cv-btn{flex:1;margin-left:0}
.cv-modal-foot .cv-btn.ghost{background:#fff;color:var(--plum);border-color:transparent}

@media (prefers-reduced-motion:reduce){
  .cv-preview-card,.cv-btn,.cv-modal{transition:none;animation:none}
}
`;
