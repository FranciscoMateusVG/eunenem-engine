import { useEffect, useState } from "react";
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

// aperture-ghvfn — Convites wizard FOUNDATION shell.
//
// Replaces the aperture-q8rr flat 6-card scrollable form with the multi-step
// progressive-configuration wizard from direction-b.jsx: a full-viewport "open
// book" layout with a dashed-spine divider, a 6-dot clickable stepper across
// the top (any-step jump, not just linear next/prev), a footer with back/next
// + a coral "enviar convite ♡" CTA on the final step, and a sticky live
// preview on the right that reacts to every keystroke. Each step contributes
// one formatting piece (event type → who → when → background → visual →
// review).
//
// THIS BEAD lands the SHELL only. Step content for tipo/quem/quando/visual
// ships in aperture-sonyh (mechanical port from the old cards); fundo +
// templates + upload + 2 new preview renderers ship in aperture-hzcy5; pronto
// review/export thumbs ship in aperture-iopmm. Until those land each step
// renders an on-brand placeholder card pointing at its sibling bead — the
// stepper, navigation, state machine, and live preview are all live and
// usable today.
//
// PRESERVED FROM aperture-q8rr:
//   • InvitePreview + ScrapbookInvite + CleanInvite preview renderers — they
//     are tuned and ship as-is on the right pane (story format).
//   • CV_CSS scrapbook token sheet (.cv tokens, .cv-card, .cv-label, etc).
//     Most are unused by the shell but kept so sibling step beads can drop
//     their card content in without reinventing primitives.
//   • The Sparkle inline svg + per-event SUGGEST copy table — sibling step
//     `quem` (aperture-sonyh) will resurrect them when it ports the ✦ AI
//     pill.
//
// DROPPED:
//   • The flat ConviteBody body (FormCard stack, formatTabs, expanded modal,
//     mobile sticky CTA) — the wizard model supersedes it. Sibling beads
//     port the field-level content into per-step components.
//   • previewScale(format, ctx) helper — replaced by a useEffect-driven
//     resize-aware scale state (matches direction-b L11-23).

// ── canned copy suggestions (mock — sibling `quem` will wire) ───────────────
// Preserved from q8rr so aperture-sonyh's StepQuem can import { SUGGEST }
// instead of re-deriving the per-event fallbacks. Operator removed the AI
// integration (aperture-4a2eh deleted), so this stays as the only source of
// suggestion copy.
export const SUGGEST: Record<string, { message: string; hashtag: string }> = {
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

// ── tiny inline icons (siblings import) ─────────────────────────────────────

export function Sparkle() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
      <path d="M5.5 0L6.6 4.4 11 5.5 6.6 6.6 5.5 11 4.4 6.6 0 5.5 4.4 4.4z" />
    </svg>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Live invite preview — scrapbook (default) + clean modes.
// Carried over verbatim from aperture-q8rr; the wizard's right pane drives
// it at format="story" only (matches direction-b). Sibling `fundo` bead adds
// TemplateInvite + UploadedInvite modes.
// ════════════════════════════════════════════════════════════════════════════

export interface PreviewProps {
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

export function InvitePreview({ state, format, fidelity, scale }: PreviewProps) {
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

// ════════════════════════════════════════════════════════════════════════════
// Wizard step machine
// ════════════════════════════════════════════════════════════════════════════

/** Stable step IDs — siblings import this union when wiring per-step views. */
export type WizardStepId = "tipo" | "quem" | "quando" | "fundo" | "visual" | "pronto";

interface WizardStep {
  id: WizardStepId;
  /** H1 shown on the left page above step content. */
  title: string;
  /** Decorative inline glyph for the stepper dot tooltip / future use. */
  icon: string;
  /** Which sibling bead will fill this step's content. */
  ownerBead: string;
}

const STEPS: readonly WizardStep[] = [
  { id: "tipo", title: "que mimo é esse?", icon: "🍼", ownerBead: "aperture-sonyh" },
  { id: "quem", title: "pra quem?", icon: "♡", ownerBead: "aperture-sonyh" },
  { id: "quando", title: "quando e onde?", icon: "☁", ownerBead: "aperture-sonyh" },
  { id: "fundo", title: "fundo do convite", icon: "✨", ownerBead: "aperture-hzcy5" },
  { id: "visual", title: "a cara do convite", icon: "✿", ownerBead: "aperture-sonyh" },
  { id: "pronto", title: "pronto pra enviar", icon: "✨", ownerBead: "aperture-iopmm" },
] as const;

/** Props shared by every step-view component (sibling beads consume these). */
export interface StepViewProps {
  state: ConviteState;
  update: <K extends keyof ConviteState>(k: K, v: ConviteState[K]) => void;
  fidelity: Fidelity;
  setFidelity: (f: Fidelity) => void;
}

// ════════════════════════════════════════════════════════════════════════════
// ConviteBody — wizard shell.
// ════════════════════════════════════════════════════════════════════════════

export function ConviteBody(_props: PainelSectionBodyProps) {
  const [state, setState] = useState<ConviteState>({ ...DEFAULT_STATE });
  const [step, setStep] = useState<number>(0);
  const [fidelity, setFidelity] = useState<Fidelity>("scrapbook");
  const [previewScale, setPreviewScale] = useState<number>(0.7);

  // Resize-aware preview scale — mirrors direction-b.jsx L11-23 with painel
  // chrome subtracted (topbar + side padding). Bounded so the preview never
  // collapses on short viewports nor blows past the right pane on tall ones.
  useEffect(() => {
    const onResize = () => {
      const h = window.innerHeight;
      const avail = h - 220; // painel topbar + wizard topbar + wizard footer + paddings
      const s = Math.min(0.95, Math.max(0.5, avail / 680));
      setPreviewScale(s);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const update = <K extends keyof ConviteState>(k: K, v: ConviteState[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const cur = STEPS[step]!;
  const isLast = step === STEPS.length - 1;
  const pct = ((step + 1) / STEPS.length) * 100;

  const goPrev = () => setStep((s) => Math.max(0, s - 1));
  const goNext = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const onSave = () => toast.success("rascunho salvo com carinho ♡");
  const onSend = () => toast.success("convite pronto! agora é só compartilhar ♡");

  const stepProps: StepViewProps = { state, update, fidelity, setFidelity };

  return (
    <div className="cv-wiz">
      <style>{CV_CSS}</style>
      <style>{CV_WIZ_CSS}</style>

      {/* spine — dashed vertical "caderninho" divider down the middle */}
      <div className="cv-wiz-spine" aria-hidden="true" />

      {/* topbar — brand + stepper + save */}
      <header className="cv-wiz-topbar">
        <div className="cv-wiz-mark" aria-hidden="true">m</div>
        <div className="cv-wiz-brand">
          <div className="cv-wiz-brand-name">convitinhos</div>
          <div className="cv-wiz-brand-step">
            passo {step + 1} de {STEPS.length}
          </div>
        </div>

        <div className="cv-wiz-stepper" role="tablist" aria-label="passos do wizard">
          <div className="cv-wiz-stepper-track" aria-hidden="true" />
          <div
            className="cv-wiz-stepper-fill"
            aria-hidden="true"
            style={{ width: `calc((100% - 24px) * ${pct / 100})` }}
          />
          <div className="cv-wiz-stepper-dots">
            {STEPS.map((s, i) => {
              const status: "done" | "on" | "todo" =
                i < step ? "done" : i === step ? "on" : "todo";
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={status === "on"}
                  aria-label={`passo ${i + 1}: ${s.title}`}
                  className={`cv-wiz-dot ${status}`}
                  onClick={() => setStep(i)}
                >
                  {status === "done" ? "✓" : i + 1}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          className="cv-btn ghost sm cv-wiz-save"
          onClick={onSave}
          aria-label="salvar rascunho"
        >
          salvar
        </button>
      </header>

      {/* body — open book: form left, preview right */}
      <div className="cv-wiz-body">
        <section className="cv-wiz-page cv-wiz-page-left" aria-label="formulário">
          <span className="cv-eyebrow">passo {step + 1} ♡</span>
          <h1 className="cv-wiz-step-title">{cur.title}</h1>

          <StepContent stepId={cur.id} ownerBead={cur.ownerBead} stepProps={stepProps} />
        </section>

        <section className="cv-wiz-page cv-wiz-page-right" aria-label="preview ao vivo">
          <div className="cv-wiz-preview-card">
            <div className="cv-wiz-tape" aria-hidden="true" />
            <InvitePreview
              state={state}
              format="story"
              fidelity={fidelity}
              scale={previewScale}
            />
            <span className="cv-wiz-preview-tag">preview ♡</span>
          </div>
        </section>
      </div>

      {/* footer — back / encouragement / next or send */}
      <footer className="cv-wiz-footer">
        <button
          type="button"
          className="cv-btn ghost"
          disabled={step === 0}
          onClick={goPrev}
          aria-label="passo anterior"
        >
          ← voltar
        </button>

        <div className="cv-wiz-footer-mid">
          <span className="cv-wiz-script">
            {isLast ? "tudo pronto!" : "tá indo bonito ♡"}
          </span>
        </div>

        {isLast ? (
          <button
            type="button"
            className="cv-btn coral"
            onClick={onSend}
            aria-label="enviar convite"
          >
            enviar convite ♡
          </button>
        ) : (
          <button
            type="button"
            className="cv-btn"
            onClick={goNext}
            aria-label="próximo passo"
          >
            próximo passo →
          </button>
        )}
      </footer>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Step content dispatch — placeholders for siblings.
// ════════════════════════════════════════════════════════════════════════════

function StepContent({
  stepId,
  ownerBead,
  stepProps,
}: {
  stepId: WizardStepId;
  ownerBead: string;
  stepProps: StepViewProps;
}) {
  // aperture-sonyh — real step views for tipo/quem/quando/visual; fundo and
  // pronto keep the placeholder until their sibling beads (hzcy5/iopmm) ship.
  switch (stepId) {
    case "tipo":
      return <StepTipo {...stepProps} />;
    case "quem":
      return <StepQuem {...stepProps} />;
    case "quando":
      return <StepQuando {...stepProps} />;
    case "visual":
      return <StepVisual {...stepProps} />;
    default:
      return <StepPlaceholder stepId={stepId} ownerBead={ownerBead} />;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// aperture-sonyh — Per-step view components
// ════════════════════════════════════════════════════════════════════════════
//
// Mechanical port of the four data-entry steps from direction-b.jsx
// (StepTipo L203, StepQuem L243, StepQuando L275, StepVisual L325) onto the
// CV_CSS primitives carried over from q8rr. Visual fidelity (rotation,
// dashed borders, eyebrow text, gradient washi tape, ✦ AI pill) matches
// direction-b; CSS comes from the existing .cv-event, .cv-pill, .cv-input,
// .cv-textarea, .cv-seg, .cv-note, .cv-swatches, .cv-swatch, .cv-fonts,
// .cv-font, .cv-grid-2, .cv-dotline, .cv-label primitives — no new
// selectors needed for these four steps.
//
// The ✦ "pedir ajuda à ia" pill on StepQuem calls into the existing SUGGEST
// lookup table (per-event fallback copy) — operator removed the real AI
// integration (aperture-4a2eh), so this stays as the only copy source.
// Mirrors the q8rr `suggestCopy` UX: write the suggestion into
// state.message AND fire a sonner success toast.

function StepTipo({ state, update }: StepViewProps) {
  // ROTATIONS — mirrors direction-b L220's per-card rotation array so each
  // event card sits a touch off-axis (scrapbook feel). Indexes wrap if
  // EVENT_TYPES ever grows past 6.
  const ROT = [-1.5, 1, -0.6, 1.2, -1, 0.8];
  return (
    <>
      <p className="cv-step-blurb">
        a gente adapta a copy, a paleta e os carimbos pra cada tipo de evento.
      </p>
      <div className="cv-event-grid">
        {EVENT_TYPES.map((e, i) => {
          const on = state.eventType === e.id;
          const rot = ROT[i % ROT.length];
          return (
            <button
              key={e.id}
              type="button"
              className={`cv-event ${on ? "on" : ""}`}
              aria-pressed={on}
              aria-label={`tipo de evento: ${e.label}`}
              onClick={() => update("eventType", e.id)}
              style={{ transform: `rotate(${rot}deg)` }}
            >
              <div className="cv-event-ico" aria-hidden="true">{e.icon}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="cv-event-label">{e.label}</div>
                <div className="cv-event-hint">{e.emojiHint}</div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function StepQuem({ state, update }: StepViewProps) {
  const ev = EVENT_BY_ID[state.eventType] ?? EVENT_TYPES[0]!;
  const isAniversario = ev.id === "aniversario";

  const suggestCopy = () => {
    const pick = SUGGEST[ev.id] ?? SUGGEST["cha-bebe"]!;
    update("message", pick.message);
    toast.success("sugestão aplicada com carinho ♡");
  };

  return (
    <>
      <label className="cv-label" htmlFor="cv-baby-name">
        {isAniversario ? "de quem é o dia" : "nome do(a) bebê"}
      </label>
      <input
        id="cv-baby-name"
        className="cv-input cv-input-lg"
        value={state.babyName}
        onChange={(e) => update("babyName", e.target.value)}
        placeholder="Maria Helena"
      />

      <hr className="cv-dotline" />

      <label className="cv-label" htmlFor="cv-host">
        de quem vem o convite
      </label>
      <input
        id="cv-host"
        className="cv-input cv-input-md"
        value={state.host}
        onChange={(e) => update("host", e.target.value)}
        placeholder="Mariana & Tiago"
      />

      <hr className="cv-dotline" />

      <div className="cv-label-row">
        <label className="cv-label" htmlFor="cv-message">
          mensagem afetiva
        </label>
        <button
          type="button"
          className="cv-pill"
          onClick={suggestCopy}
          aria-label="pedir sugestão de mensagem"
          style={{ transform: "rotate(2deg)" }}
        >
          <Sparkle /> pedir ajuda à ia
        </button>
      </div>
      <textarea
        id="cv-message"
        className="cv-textarea"
        rows={3}
        value={state.message}
        onChange={(e) => update("message", e.target.value)}
        placeholder="uma mensagem curtinha, do coração ♡"
      />
    </>
  );
}

function StepQuando({ state, update }: StepViewProps) {
  const isOnline = state.mode === "online";
  return (
    <>
      <div className="cv-card cv-mode-card">
        <label className="cv-label" style={{ marginBottom: 10 }}>
          tipo de evento
        </label>
        <div className="cv-seg" role="group" aria-label="modalidade do evento">
          <button
            type="button"
            className={state.mode === "presencial" ? "on" : ""}
            aria-pressed={state.mode === "presencial"}
            onClick={() => update("mode", "presencial")}
          >
            presencial
          </button>
          <button
            type="button"
            className={state.mode === "online" ? "on" : ""}
            aria-pressed={state.mode === "online"}
            onClick={() => update("mode", "online")}
          >
            só online
          </button>
        </div>
        {isOnline && (
          <div className="cv-note" style={{ marginTop: 12, marginBottom: 0 }}>
            ✨ data e hora ficam opcionais — se preencher, vira countdown.
          </div>
        )}
      </div>

      <div className="cv-grid-2" style={{ marginBottom: 18 }}>
        <div>
          <label className="cv-label" htmlFor="cv-date">
            data
          </label>
          <input
            id="cv-date"
            type="date"
            className="cv-input"
            value={state.date}
            onChange={(e) => update("date", e.target.value)}
          />
        </div>
        <div>
          <label className="cv-label" htmlFor="cv-time" style={{ transform: "rotate(1deg)" }}>
            horário
          </label>
          <input
            id="cv-time"
            type="time"
            className="cv-input"
            value={state.time}
            onChange={(e) => update("time", e.target.value)}
          />
        </div>
      </div>

      {isOnline ? (
        <>
          <label className="cv-label" htmlFor="cv-online-link">
            link da sala
          </label>
          <input
            id="cv-online-link"
            className="cv-input"
            value={state.onlineLink}
            placeholder="meet.google.com/..."
            onChange={(e) => update("onlineLink", e.target.value)}
          />
        </>
      ) : (
        <>
          <label className="cv-label" htmlFor="cv-address">
            endereço
          </label>
          <textarea
            id="cv-address"
            className="cv-textarea"
            rows={2}
            value={state.address}
            onChange={(e) => update("address", e.target.value)}
            placeholder="rua, número, bairro — cidade"
          />
        </>
      )}
    </>
  );
}

function StepVisual({ state, update, fidelity, setFidelity }: StepViewProps) {
  const firstName = state.babyName.split(" ")[0] ?? "";
  const surprisePalette = () => {
    const pool = PALETTES.filter((p) => p.id !== state.palette);
    const pick = pool[Math.floor(Math.random() * pool.length)] ?? PALETTES[0]!;
    update("palette", pick.id);
  };

  return (
    <>
      <label className="cv-label">paleta</label>
      <div className="cv-palette-grid">
        {PALETTES.map((p) => {
          const on = state.palette === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className={`cv-palette ${on ? "on" : ""}`}
              aria-pressed={on}
              aria-label={`paleta: ${p.label}`}
              onClick={() => update("palette", p.id)}
            >
              <div className="cv-palette-dots" aria-hidden="true">
                {[p.primary, p.deep, p.soft, p.accent].map((c, i) => (
                  <span key={i} className="cv-palette-dot" style={{ background: c }} />
                ))}
              </div>
              <div className="cv-palette-label">{p.label}</div>
            </button>
          );
        })}
        <button
          type="button"
          className="cv-palette cv-palette-surprise"
          aria-label="paleta aleatória"
          onClick={surprisePalette}
        >
          <div className="cv-palette-surprise-ico" aria-hidden="true">✨</div>
          <div className="cv-palette-label">surpresa</div>
        </button>
      </div>

      <label className="cv-label">estilo do convite</label>
      <div className="cv-grid-2" style={{ marginBottom: 22 }}>
        <button
          type="button"
          className={`cv-fidelity ${fidelity === "scrapbook" ? "on" : ""}`}
          aria-pressed={fidelity === "scrapbook"}
          onClick={() => setFidelity("scrapbook")}
        >
          <div className="cv-fidelity-title">scrapbook</div>
          <div className="cv-fidelity-hint">manuscrito, com washi tape, polaroid e carimbos</div>
        </button>
        <button
          type="button"
          className={`cv-fidelity ${fidelity === "clean" ? "on" : ""}`}
          aria-pressed={fidelity === "clean"}
          onClick={() => setFidelity("clean")}
        >
          <div className="cv-fidelity-title">limpo</div>
          <div className="cv-fidelity-hint">tipográfico, elegante, com pouca decoração</div>
        </button>
      </div>

      <label className="cv-label">fonte do nome</label>
      <div className="cv-fonts" style={{ marginBottom: 22 }}>
        {NAME_FONTS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`cv-font ${state.nameFont === f.id ? "on" : ""}`}
            aria-pressed={state.nameFont === f.id}
            aria-label={`fonte: ${f.label}`}
            onClick={() => update("nameFont", f.id)}
            style={{ fontFamily: f.css }}
          >
            {firstName || f.label}
          </button>
        ))}
      </div>

      <label className="cv-label">densidade de decoração</label>
      <div className="cv-seg" role="group" aria-label="densidade de decoração">
        {(["pouca", "media", "muita"] as const).map((d) => (
          <button
            key={d}
            type="button"
            className={state.density === d ? "on" : ""}
            aria-pressed={state.density === d}
            onClick={() => update("density", d)}
          >
            {d === "media" ? "média" : d}
          </button>
        ))}
      </div>
    </>
  );
}

function StepPlaceholder({
  stepId,
  ownerBead,
}: {
  stepId: WizardStepId;
  ownerBead: string;
}) {
  const blurb: Record<WizardStepId, string> = {
    tipo: "a gente adapta a copy, a paleta e os carimbos pra cada tipo de evento.",
    quem: "nome do(a) bebê, quem assina o convite e a mensagem afetiva ficam por aqui.",
    quando: "presencial ou online, data, horário e endereço (ou link da sala).",
    fundo:
      "ilustrações watercolor, ou uma foto sua de fundo. cada template já vem com paleta e fonte sugeridas.",
    visual: "paleta, estilo (scrapbook ou limpo), fonte do nome e densidade da decoração.",
    pronto: "revisão final em story, quadrado e link — pronto pra mandar onde quiser ♡",
  };

  return (
    <div className="cv-wiz-placeholder">
      <p className="cv-wiz-placeholder-blurb">{blurb[stepId]}</p>
      <div className="cv-wiz-placeholder-card">
        <span className="cv-eyebrow sm">a caminho</span>
        <p className="cv-wiz-placeholder-body">
          o conteúdo deste passo (<code>{stepId}</code>) chega na próxima entrega
          <strong> {ownerBead}</strong>. enquanto isso, a navegação acima já
          funciona — pode pular entre passos pra ver o preview reagindo.
        </p>
        <p className="cv-wiz-placeholder-foot">
          ✦ a fundação (esta entrega) trouxe a estrutura: o passa-página, o stepper, a
          navegação, o estado cumulativo e o preview do lado direito.
        </p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CSS — scrapbook tokens (carried over from q8rr) + wizard chrome (new).
// ════════════════════════════════════════════════════════════════════════════
//
// CV_CSS keeps the .cv-card / .cv-label / .cv-input / .cv-seg / .cv-swatch /
// .cv-event-grid primitives so sibling step beads (sonyh/hzcy5/iopmm) can
// drop in step content without reinventing chrome. Unused-by-shell selectors
// stay because the cost of removing them now and re-adding them in three
// sibling PRs is higher than the carry cost.
const CV_CSS = `
.cv,.cv-wiz{--cv-line-strong:#e2cfd8;--cv-paper:#fffcf8}
.cv *,.cv-wiz *{box-sizing:border-box}

.cv-eyebrow{font-family:var(--font-caveat),cursive;color:var(--ink-soft);font-size:19px;letter-spacing:.01em;transform:rotate(-3deg);display:inline-block;transform-origin:left bottom}
.cv-eyebrow.sm{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--lilac-deep);font-family:var(--font-dm-sans),sans-serif;transform:none}

/* form-card primitives — siblings reuse */
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
.cv-event-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:6px}
.cv-event{border:1px dashed var(--cv-line-strong);background:#fff;border-radius:14px;padding:14px;cursor:pointer;font-family:var(--font-patrick-hand),cursive;text-align:left;transition:all .15s ease;display:flex;align-items:center;gap:12px}
.cv-event:hover{border-color:var(--lilac)}
.cv-event.on{border:1.5px solid var(--lilac-deep);background:var(--lilac-soft);box-shadow:var(--shadow-sm)}
.cv-event-ico{font-size:26px;line-height:1;flex:0 0 auto}
.cv-event-label{font-size:16px;color:var(--ink);line-height:1.1}
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
.cv-swatch.surprise{background:conic-gradient(from 0deg,var(--lilac),var(--coral-pink),var(--yellow),var(--green),var(--lilac))}
.cv-swatch-name{font-family:var(--font-caveat),cursive;font-size:17px;color:var(--ink-soft);margin-left:4px}

.cv-dotline{height:1px;border:0;background-image:linear-gradient(to right,var(--cv-line-strong) 50%,transparent 50%);background-size:8px 1px;background-repeat:repeat-x;margin:18px 0}

/* fonts */
.cv-fonts{display:flex;gap:8px;flex-wrap:wrap}
.cv-font{border:1px solid var(--cv-line-strong);background:#fff;border-radius:12px;padding:8px 14px;cursor:pointer;font-size:22px;line-height:1;color:var(--plum)}
.cv-font.on{border:1.5px solid var(--lilac-deep);background:var(--lilac-soft)}

/* buttons — shared with wizard chrome below */
.cv-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;border-radius:999px;border:1px solid transparent;background:var(--lilac);color:#fff;font-family:var(--font-dm-sans),sans-serif;font-weight:600;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:transform .12s,box-shadow .15s,background .15s;box-shadow:var(--shadow-cta);white-space:nowrap}
.cv-btn:hover:not(:disabled){transform:translateY(-1px);background:var(--lilac-deep)}
.cv-btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.cv-btn.sm{padding:8px 13px;font-size:11px}
.cv-btn.ghost{background:transparent;color:var(--ink);border-color:var(--cv-line-strong);box-shadow:none}
.cv-btn.ghost:hover:not(:disabled){background:var(--cream-2);color:var(--plum)}
.cv-btn.coral{background:var(--coral-pink);box-shadow:0 8px 20px rgba(231,143,167,.4)}
.cv-btn.coral:hover:not(:disabled){background:#d4789a}

@media (prefers-reduced-motion:reduce){
  .cv-btn{transition:none}
}

/* sonyh — step-view augmentations (additive only; no overrides of q8rr base) */
.cv-step-blurb{
  color:var(--ink-soft);
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13.5px;line-height:1.55;
  margin:-12px 0 18px;
  max-width:420px;
}
.cv-event-hint{
  font-family:var(--font-caveat),cursive;
  font-size:13px;color:var(--ink-soft);
  line-height:1;margin-top:4px;
}
.cv-input-lg{font-size:28px}
.cv-input-md{font-size:23px}
.cv-label-row{
  display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
  margin-bottom:6px;
}
.cv-label-row .cv-label{margin-bottom:0}
.cv-mode-card{margin-bottom:18px}

/* palette picker — 4-col + surprise tile, slightly taller than .cv-swatches */
.cv-palette-grid{
  display:grid;grid-template-columns:repeat(4,1fr);gap:10px;
  margin-bottom:22px;
}
.cv-palette{
  border:1px solid var(--line);
  background:#fff;
  border-radius:12px;
  padding:10px 6px 8px;
  cursor:pointer;
  text-align:center;
  font-family:var(--font-patrick-hand),cursive;
  transition:box-shadow .15s ease,border-color .15s ease,transform .12s ease;
}
.cv-palette:hover{transform:translateY(-1px)}
.cv-palette.on{
  border:1.8px solid var(--lilac-deep);
  box-shadow:0 2px 8px rgba(167,123,190,.18);
}
.cv-palette-dots{display:flex;justify-content:center;gap:3px;margin-bottom:6px}
.cv-palette-dot{
  width:12px;height:12px;border-radius:50%;
  border:1.5px solid #fff;
  box-shadow:0 0 0 1px var(--cv-line-strong);
  display:inline-block;
}
.cv-palette-label{
  font-family:var(--font-patrick-hand),cursive;
  font-size:14px;color:var(--ink);line-height:1;
}
.cv-palette.on .cv-palette-label{color:var(--plum)}
.cv-palette-surprise{
  border:1px dashed var(--lilac);
  background:var(--lilac-soft);
}
.cv-palette-surprise .cv-palette-label{color:var(--plum)}
.cv-palette-surprise-ico{font-size:20px;margin-bottom:4px;line-height:1}

/* fidelity tiles — 2-up with eyebrow title + ink-soft hint */
.cv-fidelity{
  border:1px dashed var(--cv-line-strong);
  background:#fff;
  border-radius:14px;
  padding:14px;
  cursor:pointer;
  text-align:left;
  font-family:var(--font-patrick-hand),cursive;
  transition:border-color .15s ease,background .15s ease,box-shadow .15s ease;
}
.cv-fidelity:hover{border-color:var(--lilac)}
.cv-fidelity.on{
  border:1.8px solid var(--lilac-deep);
  background:var(--lilac-soft);
  box-shadow:var(--shadow-sm);
}
.cv-fidelity-title{
  font-family:var(--font-patrick-hand),cursive;
  font-size:19px;color:var(--plum);line-height:1;
}
.cv-fidelity-hint{
  font-family:var(--font-dm-sans),sans-serif;
  font-size:11px;color:var(--ink-soft);
  margin-top:4px;line-height:1.3;
}

@media (prefers-reduced-motion:reduce){
  .cv-palette,.cv-fidelity{transition:none}
  .cv-palette:hover{transform:none}
}
`;

// CV_WIZ_CSS = the new wizard chrome (shell, spine, topbar, stepper, body
// dual-pane, preview card, footer, placeholder). Everything is namespaced
// under .cv-wiz so it never collides with the q8rr .cv selectors.
const CV_WIZ_CSS = `
.cv-wiz{
  position:relative;
  background:var(--paper);
  border:1px solid var(--line);
  border-radius:20px;
  box-shadow:var(--shadow-sm);
  overflow:hidden;
  display:flex;
  flex-direction:column;
  min-height:700px;
}

/* dashed vertical "caderninho" spine — desktop only */
.cv-wiz-spine{
  position:absolute;
  top:80px;bottom:80px;left:50%;
  width:2px;margin-left:-1px;
  background:repeating-linear-gradient(to bottom,
    var(--cv-line-strong) 0,var(--cv-line-strong) 6px,
    transparent 6px,transparent 12px);
  opacity:.55;
  pointer-events:none;
  z-index:1;
}
@media (max-width:1039px){
  .cv-wiz-spine{display:none}
}

/* ── topbar ─────────────────────────────────────────────────────────── */
.cv-wiz-topbar{
  position:relative;z-index:5;
  padding:18px 24px 14px;
  display:flex;align-items:center;gap:16px;
  border-bottom:1px solid var(--line);
  background:rgba(255,255,255,.55);
  flex-wrap:wrap;
}
.cv-wiz-mark{
  width:36px;height:36px;border-radius:10px;
  background:var(--lilac);color:#fff;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-patrick-hand),cursive;font-size:22px;line-height:1;
  transform:rotate(-4deg);
  box-shadow:var(--shadow-cta);
  flex:0 0 auto;
}
.cv-wiz-brand{flex:0 0 auto;min-width:0}
.cv-wiz-brand-name{font-family:var(--font-patrick-hand),cursive;font-size:20px;color:var(--plum);line-height:1}
.cv-wiz-brand-step{font-family:var(--font-dm-sans),sans-serif;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin-top:4px}

/* stepper — track + fill + 6 clickable dots */
.cv-wiz-stepper{
  flex:1 1 280px;
  position:relative;
  padding:0 20px;
  height:30px;
  min-width:240px;
}
.cv-wiz-stepper-track{
  position:absolute;
  top:13px;left:32px;right:32px;
  height:3px;border-radius:2px;
  background:var(--cv-line-strong);
}
.cv-wiz-stepper-fill{
  position:absolute;
  top:13px;left:32px;
  height:3px;border-radius:2px;
  background:linear-gradient(90deg,var(--green),var(--lilac));
  transition:width .35s ease;
}
.cv-wiz-stepper-dots{
  position:relative;
  display:flex;justify-content:space-between;align-items:center;
  height:30px;
  z-index:1;
}
.cv-wiz-dot{
  width:30px;height:30px;border-radius:50%;
  border:2px solid #fff;
  cursor:pointer;padding:0;
  font-family:var(--font-patrick-hand),cursive;font-size:14px;line-height:1;
  display:flex;align-items:center;justify-content:center;
  transition:transform .15s ease,box-shadow .2s ease,background .2s ease;
}
.cv-wiz-dot.todo{background:var(--cream-2);color:var(--ink-mute)}
.cv-wiz-dot.done{background:var(--green-deep,#8AA53A);color:#fff}
.cv-wiz-dot.on{
  background:var(--lilac-deep);color:#fff;
  box-shadow:0 0 0 4px rgba(167,123,190,.25);
  transform:scale(1.1);
}
.cv-wiz-dot:hover:not(.on){transform:scale(1.08)}
.cv-wiz-dot:focus-visible{outline:2px solid var(--lilac-deep);outline-offset:3px}

.cv-wiz-save{flex:0 0 auto;margin-left:auto}

/* ── body — open book ────────────────────────────────────────────── */
.cv-wiz-body{
  position:relative;
  flex:1 1 auto;
  display:grid;
  grid-template-columns:1fr 1fr;
  min-height:0;
  z-index:2;
}
.cv-wiz-page{
  position:relative;
  min-width:0;
  padding:32px 40px 36px;
  overflow-y:auto;
}
.cv-wiz-page-left{
  border-right:none;
}
.cv-wiz-page-right{
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px 40px;
  background:linear-gradient(180deg,transparent 0,rgba(232,213,240,.18) 100%);
}

.cv-wiz-step-title{
  font-family:var(--font-patrick-hand),cursive;
  font-size:38px;
  color:var(--plum);
  margin:6px 0 22px;
  line-height:1;
  letter-spacing:-.01em;
  font-weight:600;
}

/* preview card on the right pane — washi-taped polaroid frame */
.cv-wiz-preview-card{
  position:relative;
  transform:rotate(-1.5deg);
  padding:16px;
  background:#fff;
  border:1px solid var(--line);
  border-radius:14px;
  box-shadow:0 6px 18px rgba(107,60,94,.16),0 1px 0 rgba(107,60,94,.04);
}
.cv-wiz-tape{
  position:absolute;
  top:-11px;left:42px;
  width:72px;height:22px;
  background:repeating-linear-gradient(45deg,
    rgba(255,255,255,.42) 0,rgba(255,255,255,.42) 4px,
    transparent 4px,transparent 9px),
    var(--lilac-soft);
  transform:rotate(-4deg);
  box-shadow:0 1px 3px rgba(107,60,94,.12);
}
.cv-wiz-preview-tag{
  position:absolute;
  bottom:-22px;right:10px;
  transform:rotate(4deg);
  font-family:var(--font-caveat),cursive;
  font-size:17px;color:var(--ink-soft);
}

/* mobile / narrow — collapse to a single column with preview hero on top */
@media (max-width:1039px){
  .cv-wiz-body{
    grid-template-columns:1fr;
  }
  .cv-wiz-page-right{
    order:-1;
    padding:24px 24px 8px;
    min-height:0;
  }
  .cv-wiz-page-left{
    padding:24px 24px 32px;
  }
  .cv-wiz-step-title{font-size:32px}
}

/* very narrow — relax the stepper so it never overflows */
@media (max-width:640px){
  .cv-wiz-topbar{padding:14px 16px 12px;gap:12px}
  .cv-wiz-brand{flex:1 1 auto}
  .cv-wiz-stepper{flex:1 1 100%;order:3;padding:0 4px}
  .cv-wiz-save{margin-left:0}
  .cv-wiz-page-left{padding:20px}
  .cv-wiz-page-right{padding:20px 20px 4px}
}

/* ── footer — back / encouragement / next ─────────────────────────── */
.cv-wiz-footer{
  position:relative;z-index:3;
  padding:14px 24px;
  border-top:1px solid var(--line);
  background:rgba(255,255,255,.7);
  display:flex;align-items:center;gap:16px;
  flex-wrap:wrap;
}
.cv-wiz-footer-mid{flex:1 1 auto;text-align:center;min-width:80px}
.cv-wiz-script{
  font-family:var(--font-caveat),cursive;
  font-size:18px;
  color:var(--ink-soft);
}

/* ── placeholder card (until step content lands in sibling beads) ──── */
.cv-wiz-placeholder{display:flex;flex-direction:column;gap:18px;max-width:520px}
.cv-wiz-placeholder-blurb{
  color:var(--ink-soft);
  font-family:var(--font-dm-sans),sans-serif;
  font-size:13.5px;line-height:1.55;
  margin:-12px 0 0;
}
.cv-wiz-placeholder-card{
  background:linear-gradient(135deg,var(--lilac-soft),#fff 90%);
  border:1.5px dashed var(--lilac);
  border-radius:18px;
  padding:18px 20px;
  display:flex;flex-direction:column;gap:10px;
}
.cv-wiz-placeholder-body{
  margin:0;
  font-family:var(--font-patrick-hand),cursive;
  font-size:17px;line-height:1.45;
  color:var(--ink);
}
.cv-wiz-placeholder-body code{
  font-family:var(--font-dm-sans),monospace;
  background:rgba(255,255,255,.6);
  border:1px solid var(--line);
  border-radius:6px;
  padding:0 6px;
  font-size:13px;
  color:var(--plum);
}
.cv-wiz-placeholder-body strong{color:var(--lilac-deep);font-weight:600}
.cv-wiz-placeholder-foot{
  margin:0;
  font-family:var(--font-caveat),cursive;
  font-size:16px;line-height:1.4;
  color:var(--plum);
}

@media (prefers-reduced-motion:reduce){
  .cv-wiz-stepper-fill,.cv-wiz-dot{transition:none}
}
`;
