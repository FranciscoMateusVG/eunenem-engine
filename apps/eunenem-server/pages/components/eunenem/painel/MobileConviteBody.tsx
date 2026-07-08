import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  conviteErrorMessage,
  conviteStateFromData,
  savePayloadFromConviteState,
  scrapbookSelectionPatch,
  templateSelectionPatch,
  uploadSelectionPatch,
  useConviteData,
  useSalvarConvite,
} from "@/lib/convite";
import { useCampanhaRota } from "@/lib/campanha-rota";
import { shareConvitePreview } from "@/lib/convite-share";
import { useConviteBackgroundUpload } from "@/lib/conviteUpload";
import { painelConvitePreviewHref } from "@/lib/painelRoutes";
import {
  DEFAULT_STATE,
  DISABLED_EVENT_TYPES,
  EVENT_BY_ID,
  EVENT_TYPES,
  NAME_FONTS,
  PALETTES,
  type ConviteState,
} from "@/lib/mocks/convite";
import { TEMPLATES, type Template } from "@/lib/mocks/templates";

import { InvitePreview, SUGGEST, conviteFieldErrors } from "./ConviteBody";

// aperture-zlrd2 — Mobile-specific convites wizard.
//
// Sibling of the desktop wizard in ConviteBody.tsx. ConviteBody now boots a
// viewport check at the top and dispatches to this component below ~640px;
// everything else keeps its desktop layout. Two flows, one state shape.
//
// Per operator scope decisions:
//   • 5 steps (drops `pronto` — exports live on the fullscreen modal's
//     download bar).
//   • Step order: fundo → tipo → quem → quando → visual (mobile leads with
//     picking a background; desktop is tipo-first).
//   • Fidelity is hard-coded scrapbook (no toggle on mobile).
//   • No AI on this round (aperture-4a2eh closed): the SUGGEST dict from
//     ConviteBody is the message helper; the AI pill on fundo step is
//     dropped entirely.
//   • Non-interactive stepper — just a progress bar + decorative dot. Text
//     label "passo N de N · {title}" carries the wayfinding.
//   • Sticky bottom CTA bar (48×48 back + flex-1 primary, swaps coral on
//     last step).
//   • Scroll-snap carousels for palette + name-font.
//   • Accent-normalized template search (mobile-only).
//   • Safe-area insets via env(safe-area-inset-*) — server.tsx also bumps
//     the viewport meta to include viewport-fit=cover so the env() values
//     return non-zero on notched iOS.
//   • Templates grid IS in scope but the data layer (lib/mocks/convite.ts
//     TEMPLATES) ships from sibling aperture-hzcy5 (Vance). Until that
//     lands, fundo step renders the "papel" option + accent-normalized
//     search box + photo upload, and a "templates a caminho ♡" placeholder
//     in the grid slot. When hzcy5 ships TEMPLATES, the grid lights up
//     without further edits here (TODO: re-import once it exists).

// ─── data layer ──────────────────────────────────────────────────────

interface WizStep {
  id: "fundo" | "tipo" | "quem" | "quando" | "visual";
  title: string;
}

const STEPS: readonly WizStep[] = [
  { id: "fundo", title: "fundo do convite" },
  { id: "tipo", title: "qual tipo de evento?" },
  { id: "quem", title: "pra quem?" },
  { id: "quando", title: "quando e onde?" },
  { id: "visual", title: "a cara do convite" },
] as const;

// aperture-qa2m3 — desktop is canonical and story-only (direction-b); mobile
// no longer exposes square/link, so the preview renders at a single story scale.
const PREVIEW_SCALE_HERO_STORY = 0.5;
const PREVIEW_SCALE_MODAL_STORY = 0.75;

/** NFD + diacritic strip + lowercase. Used by fundo step search to match
 *  "balao" against "balão" etc. */
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface StepProps {
  state: ConviteState;
  update: <K extends keyof ConviteState>(k: K, v: ConviteState[K]) => void;
  /** aperture-qa2m3 — atomic multi-field patch for the shared template cascade. */
  updateMany: (patch: Partial<ConviteState>) => void;
}

// ─── shell ──────────────────────────────────────────────────────────

export function MobileConviteBody({ slug }: PainelSectionBodyProps) {
  // aperture-z6vks — keep the /c/:idCampanha context on the preview link.
  const idCampanha = useCampanhaRota();
  const [state, setState] = useState<ConviteState>({ ...DEFAULT_STATE });
  const [step, setStep] = useState(0);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const conviteQuery = useConviteData();
  const salvarConvite = useSalvarConvite();
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!conviteQuery.data || hydratedRef.current) return;
    setState(conviteStateFromData(conviteQuery.data));
    hydratedRef.current = true;
  }, [conviteQuery.data]);

  const update = <K extends keyof ConviteState>(
    k: K,
    v: ConviteState[K],
  ) => setState((s) => ({ ...s, [k]: v }));
  const updateMany = (patch: Partial<ConviteState>) =>
    setState((s) => ({ ...s, ...patch }));

  const cur = STEPS[step]!;
  const pct = ((step + 1) / STEPS.length) * 100;
  const isLast = step === STEPS.length - 1;
  const isSaving = salvarConvite.isPending;
  const isSending = isSaving || isSharing;

  const goPrev = () => setStep((s) => Math.max(0, s - 1));
  const goNext = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  // aperture-rw880 — block save/send when required fields (nomeExibido=babyName,
  // remetente=host, dataHoraIso=date) are empty, with a friendly toast instead
  // of the raw backend 400.
  const guardComplete = (): boolean => {
    const errs = conviteFieldErrors(state);
    if (Object.keys(errs).length > 0) {
      toast.error("faltou preencher alguns campos ♡", {
        description: Object.values(errs).join(" · "),
      });
      return false;
    }
    return true;
  };
  const onSave = async () => {
    if (!guardComplete()) return;
    try {
      await salvarConvite.mutateAsync(savePayloadFromConviteState(state));
      toast.success("rascunho salvo com carinho ♡");
    } catch (error) {
      toast.error("não deu pra salvar agora", {
        description: conviteErrorMessage(error),
      });
    }
  };
  const onSend = async () => {
    if (!guardComplete()) return;
    setIsSharing(true);
    try {
      // aperture-b4z9k — share FIRST so navigator.share() runs synchronously in
      // the gesture (Safari drops transient activation if the tRPC save awaits
      // before it → NotAllowedError). The slug URL is valid pre-save; persist
      // after.
      try {
        const result = await shareConvitePreview({
          slug,
          title: `Convite de ${state.babyName || 'nosso evento'}`,
          text: "Quero te mostrar este convite.",
        });

        if (result === 'shared') {
          toast.success("interface de compartilhamento aberta ♡");
        } else if (result === 'copied') {
          toast.success("link do convite copiado ♡");
        } else {
          toast.success("convite salvo com carinho ♡");
        }
      } catch {
        toast.error("não deu pra compartilhar agora", {
          description: "Tente novamente em um navegador com suporte ou copie o link depois.",
        });
      }
      await salvarConvite.mutateAsync(savePayloadFromConviteState(state));
    } catch (error) {
      toast.error("não deu pra salvar agora", {
        description: conviteErrorMessage(error),
      });
    } finally {
      setIsSharing(false);
    }
  };

  const stepProps: StepProps = { state, update, updateMany };

  return (
    <div className="mcv-wiz">
      <style>{MCV_CSS}</style>

      {/* HEADER (sticky top, safe-area top inset) */}
      <header className="mcv-header">
        <div className="mcv-mark" aria-hidden="true">m</div>
        <div className="mcv-brand">
          <div className="mcv-brand-name">meu convite</div>
          <div className="mcv-brand-step">
            passo {step + 1} de {STEPS.length} · {cur.title}
          </div>
        </div>
        <button type="button" className="mcv-save" onClick={onSave} disabled={isSaving}>
          {isSaving ? "salvando..." : "salvar"}
        </button>
        <a href={painelConvitePreviewHref(slug, idCampanha)} className="mcv-save">
          ver salvo
        </a>
      </header>

      {/* PROGRESS BAR — non-interactive */}
      <div className="mcv-progress-wrap" aria-hidden="true">
        <div className="mcv-progress-track" />
        <div className="mcv-progress-fill" style={{ width: `${pct}%` }} />
        <div className="mcv-progress-dot" style={{ left: `${pct}%` }} />
      </div>

      {/* PREVIEW HERO — tap to expand */}
      <div className="mcv-hero">
        <button
          type="button"
          className="mcv-hero-card"
          onClick={() => setPreviewExpanded(true)}
          aria-label="abrir prévia em tela cheia"
        >
          <span className="mcv-hero-tape" aria-hidden="true" />
          <InvitePreview
            state={state}
            format="story"
            fidelity="scrapbook"
            scale={PREVIEW_SCALE_HERO_STORY}
          />
          <span className="mcv-hero-expand" aria-hidden="true">⤢</span>
        </button>

        {/* aperture-qa2m3 — square/link format tabs removed: desktop is canonical
            and story-only (direction-b), so mobile no longer offers them. */}
        <div className="mcv-fmt-row">
          <span className="mcv-fmt-eyebrow">seu convite ♡</span>
        </div>
      </div>

      {/* CONTENT (scrollable) */}
      <main className="mcv-content">
        <span className="mcv-eyebrow">passo {step + 1} ♡</span>
        <h1 className="mcv-step-title">{cur.title}</h1>

        {cur.id === "fundo" && <MStepFundo {...stepProps} />}
        {cur.id === "tipo" && <MStepTipo {...stepProps} />}
        {cur.id === "quem" && <MStepQuem {...stepProps} />}
        {cur.id === "quando" && <MStepQuando {...stepProps} />}
        {cur.id === "visual" && <MStepVisual {...stepProps} />}
      </main>

      {/* FOOTER (sticky CTA, safe-area bottom inset) */}
      <footer className="mcv-footer">
        {step > 0 && (
          <button
            type="button"
            className="mcv-footer-back"
            onClick={goPrev}
            aria-label="passo anterior"
          >
            ←
          </button>
        )}
        <button
          type="button"
          className={`mcv-footer-cta ${isLast ? "is-last" : ""}`}
          onClick={isLast ? onSend : goNext}
          disabled={isLast ? isSending : isSaving}
        >
          {isSaving
            ? "salvando..."
            : isLast
              ? isSharing
                ? "compartilhando..."
                : "enviar convite ♡"
              : "próximo passo →"}
        </button>
      </footer>

      {previewExpanded && (
        <PreviewModal
          state={state}
          onClose={() => setPreviewExpanded(false)}
        />
      )}
    </div>
  );
}

// ─── fullscreen preview modal ───────────────────────────────────────

function PreviewModal({
  state,
  onClose,
}: {
  state: ConviteState;
  onClose: () => void;
}) {
  // Close on ESC for the rare keyboard-mobile case (Bluetooth keyboards
  // exist; doesn't hurt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // aperture-qa2m3 follow-up: real copy/download (desktop uses downloadConvitePng
  // + shareConvitePreview) is out of scope here — still mock toasts.
  const onCopy = () => toast.success("link copiado ♡ (mock)");
  const onDownload = () => toast.success("baixando convite ♡ (mock)");

  return (
    <div
      className="mcv-modal"
      role="dialog"
      aria-modal="true"
      aria-label="prévia do convite"
      onClick={onClose}
    >
      <div className="mcv-modal-header" onClick={(e) => e.stopPropagation()}>
        <span className="mcv-modal-eyebrow">seu convite ♡</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="mcv-modal-close"
          onClick={onClose}
          aria-label="fechar prévia"
        >
          ×
        </button>
      </div>

      {/* aperture-qa2m3 — story-only (desktop canonical); format tabs removed. */}
      <div className="mcv-modal-stage" onClick={(e) => e.stopPropagation()}>
        <div className="mcv-modal-preview">
          <span className="mcv-modal-tape" aria-hidden="true" />
          <InvitePreview
            state={state}
            format="story"
            fidelity="scrapbook"
            scale={PREVIEW_SCALE_MODAL_STORY}
          />
        </div>
      </div>

      <div className="mcv-modal-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="mcv-modal-ghost" onClick={onCopy}>
          copiar link
        </button>
        <button type="button" className="mcv-modal-primary" onClick={onDownload}>
          baixar ↓
        </button>
      </div>
    </div>
  );
}

// ─── step: fundo ─────────────────────────────────────────────────────

function MStepFundo({ state, update, updateMany }: StepProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // aperture-j4zjw — upload the photo to storage so it persists (was a base64
  // dataUrl held only in client state and dropped on save).
  const { upload, uploading } = useConviteBackgroundUpload();

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const url = await upload(file);
      updateMany(uploadSelectionPatch(url));
    } catch {
      toast.error("não consegui enviar a imagem — tenta de novo?");
    }
  };

  // aperture-qa2m3 — the real 12 watercolor templates (same TEMPLATES the desktop
  // uses), no longer a stub. Accent-normalized search by label / id / event type.
  const q = normalize(query.trim());
  const filtered: Template[] = q
    ? TEMPLATES.filter(
        (t) =>
          normalize(t.label).includes(q) ||
          normalize(t.id).includes(q) ||
          t.forEvents.some((ev) => normalize(ev).includes(q)),
      )
    : TEMPLATES;

  const paperActive = state.bgTemplate === "none" && !state.bgUpload;

  return (
    <div className="mcv-stack">
      {/* search bar */}
      <div className="mcv-search">
        <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          className="mcv-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="buscar tema (flores, balão, safari…)"
          aria-label="buscar tema"
        />
        {query && (
          <button
            type="button"
            className="mcv-search-clear"
            onClick={() => setQuery("")}
            aria-label="limpar busca"
          >
            ×
          </button>
        )}
      </div>

      <div>
        <label className="mcv-label" htmlFor="mcv-fundo-grid">
          {q
            ? `${filtered.length} resultado${filtered.length === 1 ? "" : "s"} pra "${query}"`
            : "templates"}
        </label>
        <div id="mcv-fundo-grid" className="mcv-fundo-grid">
          {/* "sem fundo" — papel scrapbook (default) */}
          {!q && (
            <button
              type="button"
              className={`mcv-tpl ${paperActive ? "on" : ""}`}
              onClick={() => updateMany(scrapbookSelectionPatch())}
            >
              <div className="mcv-tpl-thumb mcv-tpl-thumb-paper">papel</div>
              <div className="mcv-tpl-label">scrapbook</div>
            </button>
          )}

          {/* aperture-qa2m3 — the 12 watercolor templates, same as desktop.
              Picking one cascades palette + font via the shared patch. */}
          {filtered.map((tpl) => {
            const active = state.bgTemplate === tpl.id && !state.bgUpload;
            return (
              <button
                type="button"
                key={tpl.id}
                className={`mcv-tpl ${active ? "on" : ""}`}
                aria-pressed={active}
                aria-label={`template ${tpl.label}`}
                onClick={() => updateMany(templateSelectionPatch(tpl))}
              >
                <div
                  className="mcv-tpl-thumb"
                  style={{ background: `url("${tpl.img}") center/cover, white` }}
                  aria-hidden="true"
                />
                <div className="mcv-tpl-label">
                  {tpl.emoji} {tpl.label}
                </div>
              </button>
            );
          })}

          {q && filtered.length === 0 && (
            <div className="mcv-fundo-empty">
              <div className="mcv-fundo-empty-glyph">🔍</div>
              <div className="mcv-fundo-empty-title">nada encontrado ♡</div>
              <div className="mcv-fundo-empty-sub">tenta "flores", "balão", "safari", "lavanda"…</div>
            </div>
          )}
        </div>
      </div>

      {/* upload */}
      <div>
        <label className="mcv-label">ou usa uma foto sua</label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => onUpload(e.target.files?.[0])}
        />
        {state.bgUpload ? (
          <div className="mcv-upload-active">
            <div
              className="mcv-upload-thumb"
              style={{ backgroundImage: `url("${state.bgUpload}")` }}
            />
            <div className="mcv-upload-meta">
              <div className="mcv-upload-title">imagem ♡</div>
              <div className="mcv-upload-sub">vira fundo do convite</div>
            </div>
            <button
              type="button"
              className="mcv-upload-clear"
              onClick={() => update("bgUpload", null)}
              disabled={uploading}
            >
              tirar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="mcv-upload-empty"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            <span className="mcv-upload-plus" aria-hidden="true">＋</span>
            <span className="mcv-upload-empty-body">
              <span className="mcv-upload-title">
                {uploading ? "enviando…" : "enviar foto"}
              </span>
              <span className="mcv-upload-sub">jpg, png — o texto aparece em cima</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── step: tipo ──────────────────────────────────────────────────────

function MStepTipo({ state, update }: StepProps) {
  // Per-card rotation pattern mirrors direction-mobile.jsx L355.
  const rotations = [-1.5, 1, -0.6, 1.2, -1, 0.8];
  return (
    <div className="mcv-tipo-grid">
      {EVENT_TYPES.map((e, i) => {
        const on = state.eventType === e.id;
        return (
          <button
            key={e.id}
            type="button"
            className={`mcv-tipo ${on ? "on" : ""}`}
            style={{ transform: `rotate(${rotations[i % rotations.length]}deg)` }}
            onClick={() => update("eventType", e.id)}
            aria-pressed={on}
          >
            <div className="mcv-tipo-ico" aria-hidden="true">{e.icon}</div>
            <div className="mcv-tipo-body">
              <div className="mcv-tipo-label">{e.label}</div>
              <div className="mcv-tipo-hint">{e.emojiHint}</div>
            </div>
          </button>
        );
      })}
      {DISABLED_EVENT_TYPES.map((e, i) => (
        <button
          key={e.id}
          type="button"
          className="mcv-tipo"
          disabled
          aria-disabled="true"
          aria-label={`tipo de evento: ${e.label} (em breve)`}
          style={{
            transform: `rotate(${rotations[(EVENT_TYPES.length + i) % rotations.length]}deg)`,
            opacity: 0.5,
            cursor: "not-allowed",
            pointerEvents: "none",
          }}
        >
          <div className="mcv-tipo-ico" aria-hidden="true">{e.icon}</div>
          <div className="mcv-tipo-body">
            <div className="mcv-tipo-label">
              {e.label} <span className="mcv-tipo-soon">em breve</span>
            </div>
            <div className="mcv-tipo-hint">{e.emojiHint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── step: quem ──────────────────────────────────────────────────────

function MStepQuem({ state, update }: StepProps) {
  const ev = EVENT_BY_ID[state.eventType] ?? EVENT_TYPES[0]!;
  // aperture-39blz — the "✦ sugestão" (pedir ajuda à IA) pill was removed; the
  // SUGGEST copy is still used only as the textarea placeholder hint.
  const suggestion = SUGGEST[state.eventType] ?? SUGGEST["cha-bebe"]!;

  return (
    <div className="mcv-stack">
      <div>
        <label className="mcv-label" htmlFor="mcv-babyname">
          {ev.id === "aniversario" ? "de quem é o dia" : "nome do(a) bebê"}
        </label>
        <input
          id="mcv-babyname"
          className="mcv-field"
          value={state.babyName}
          onChange={(e) => update("babyName", e.target.value)}
          placeholder="Maria Helena"
        />
      </div>
      <div>
        <label className="mcv-label mcv-label-tilt" htmlFor="mcv-host">
          de quem vem o convite
        </label>
        <input
          id="mcv-host"
          className="mcv-field"
          value={state.host}
          onChange={(e) => update("host", e.target.value)}
          placeholder="Mariana & Tiago"
        />
      </div>
      <div>
        {/* aperture-39blz — removed the "✦ sugestão" (pedir ajuda à IA) pill;
            the affectionate message should be the creator's own words. */}
        <label className="mcv-label" htmlFor="mcv-message">
          mensagem afetiva
        </label>
        <textarea
          id="mcv-message"
          className="mcv-textarea"
          rows={3}
          value={state.message}
          onChange={(e) => update("message", e.target.value)}
          placeholder={suggestion.message}
        />
      </div>
    </div>
  );
}

// ─── step: quando ────────────────────────────────────────────────────

function MStepQuando({ state, update }: StepProps) {
  return (
    <div className="mcv-stack">
      <div>
        <label className="mcv-label">tipo de evento</label>
        <div className="mcv-mode-grid">
          {(
            [
              ["presencial", "presencial", "📍"],
              ["online", "só online", "📱"],
            ] as const
          ).map(([id, l, ic]) => {
            const on = state.mode === id;
            return (
              <button
                key={id}
                type="button"
                className={`mcv-mode ${on ? "on" : ""}`}
                onClick={() => update("mode", id)}
                aria-pressed={on}
              >
                <div className="mcv-mode-ico" aria-hidden="true">{ic}</div>
                <div className="mcv-mode-label">{l}</div>
              </button>
            );
          })}
        </div>
        {state.mode === "online" && (
          <div className="mcv-note">✨ data e hora opcionais — viram countdown.</div>
        )}
      </div>

      <div className="mcv-date-row">
        <div>
          <label className="mcv-label" htmlFor="mcv-date">data</label>
          <input
            id="mcv-date"
            className="mcv-field"
            type="date"
            value={state.date}
            onChange={(e) => update("date", e.target.value)}
          />
        </div>
        <div>
          <label className="mcv-label mcv-label-tilt" htmlFor="mcv-time">
            horário
          </label>
          <input
            id="mcv-time"
            className="mcv-field"
            type="time"
            value={state.time}
            onChange={(e) => update("time", e.target.value)}
          />
        </div>
      </div>

      {state.mode === "presencial" ? (
        <div>
          <label className="mcv-label" htmlFor="mcv-address">endereço</label>
          <textarea
            id="mcv-address"
            className="mcv-textarea"
            rows={2}
            value={state.address}
            onChange={(e) => update("address", e.target.value)}
          />
        </div>
      ) : (
        <div>
          <label className="mcv-label" htmlFor="mcv-link">link da sala (opcional)</label>
          <input
            id="mcv-link"
            className="mcv-field"
            value={state.onlineLink}
            onChange={(e) => update("onlineLink", e.target.value)}
            placeholder="meet.google.com/..."
          />
        </div>
      )}
    </div>
  );
}

// ─── step: visual ────────────────────────────────────────────────────
// NO fidelity toggle on mobile per operator. Just palette + nameFont.

function MStepVisual({ state, update }: StepProps) {
  const pickRandomPalette = () => {
    const r = PALETTES[Math.floor(Math.random() * PALETTES.length)]!;
    update("palette", r.id);
  };
  return (
    <div className="mcv-stack">
      <div>
        <label className="mcv-label">paleta</label>
        <div className="mcv-carousel no-scrollbar">
          {PALETTES.map((p) => {
            const on = state.palette === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`mcv-pal ${on ? "on" : ""}`}
                onClick={() => update("palette", p.id)}
                aria-pressed={on}
              >
                <div className="mcv-pal-dots" aria-hidden="true">
                  {[p.primary, p.deep, p.soft, p.accent].map((c, i) => (
                    <span key={i} className="mcv-pal-dot" style={{ background: c }} />
                  ))}
                </div>
                <div className="mcv-pal-label">{p.label}</div>
              </button>
            );
          })}
          <button
            type="button"
            className="mcv-pal mcv-pal-surprise"
            onClick={pickRandomPalette}
            aria-label="paleta surpresa"
          >
            <div className="mcv-pal-surprise-glyph" aria-hidden="true">✨</div>
            <div className="mcv-pal-label">surpresa</div>
          </button>
        </div>
      </div>

      <div>
        <label className="mcv-label">fonte do nome</label>
        <div className="mcv-carousel no-scrollbar">
          {NAME_FONTS.map((f) => {
            const on = state.nameFont === f.id;
            return (
              <button
                key={f.id}
                type="button"
                className={`mcv-font ${on ? "on" : ""}`}
                style={{ fontFamily: f.css }}
                onClick={() => update("nameFont", f.id)}
                aria-pressed={on}
              >
                {(state.babyName.split(" ")[0] || "Mari").slice(0, 8)}
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ─── CSS ─────────────────────────────────────────────────────────────
// All selectors namespaced under .mcv- to avoid colliding with the
// desktop wizard's .cv-wiz- chrome.

const MCV_CSS = `
.mcv-wiz{
  position:fixed;inset:0;
  /* sits above the painel chrome (no z) and the dev TweaksPanel (z 60),
     so the mobile wizard is the foreground "screen" while in use.
     production builds drop TweaksPanel; this z-index just keeps dev
     verification clean too. */
  z-index:75;
  display:flex;flex-direction:column;
  height:100dvh;min-height:600px;max-height:100dvh;
  background:var(--paper);
  overflow:hidden;
  font-family:var(--font-dm-sans),system-ui,sans-serif;
}
/* On screens >MOBILE_BREAKPOINT the dispatcher in ConviteBody renders the
   desktop wizard instead — but if this file is ever imported standalone
   under desktop CSS, fall back to in-flow positioning. */
@media (min-width:641px){
  .mcv-wiz{position:relative;inset:auto;z-index:auto}
}
.mcv-wiz *{box-sizing:border-box}

/* HEADER ─────────────────────────────── */
.mcv-header{
  flex:0 0 auto;
  padding:calc(env(safe-area-inset-top,0px) + 14px) 14px 8px;
  background:rgba(248,247,246,.94);
  backdrop-filter:blur(14px);
  -webkit-backdrop-filter:blur(14px);
  display:flex;align-items:center;gap:10px;
  z-index:8;
}
.mcv-mark{
  width:28px;height:28px;border-radius:8px;
  background:var(--lilac);color:#fff;
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-patrick-hand),cursive;
  font-size:16px;line-height:1;
  transform:rotate(-4deg);
  box-shadow:var(--shadow-cta);
  flex:0 0 auto;
}
.mcv-brand{flex:1 1 auto;min-width:0}
.mcv-brand-name{
  font-family:var(--font-patrick-hand),cursive;
  font-size:16px;color:var(--plum);line-height:1;
}
.mcv-brand-step{
  font-size:9px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-soft);margin-top:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.mcv-save{
  background:transparent;border:none;cursor:pointer;
  color:var(--ink-soft);font-family:var(--font-caveat),cursive;
  font-size:16px;padding:8px 8px;
  min-height:44px;
  flex:0 0 auto;
}

/* PROGRESS ───────────────────────────── */
.mcv-progress-wrap{
  flex:0 0 auto;
  position:relative;
  margin:2px 14px 6px;
  height:13px;
  background:rgba(248,247,246,.94);
  border-bottom:1px solid var(--line);
  padding-bottom:8px;
}
.mcv-progress-track{
  position:absolute;
  top:4px;left:0;right:0;
  height:5px;border-radius:3px;
  background:var(--line);
}
.mcv-progress-fill{
  position:absolute;
  top:4px;left:0;
  height:5px;border-radius:3px;
  background:linear-gradient(90deg,var(--green),var(--lilac));
  transition:width .35s ease;
}
.mcv-progress-dot{
  position:absolute;
  top:1px;
  width:11px;height:11px;border-radius:50%;
  background:#fff;
  border:2.5px solid var(--lilac-deep);
  box-shadow:0 1px 3px rgba(107,60,94,.18);
  transform:translateX(-50%);
  transition:left .35s ease;
}

/* PREVIEW HERO ───────────────────────── */
.mcv-hero{
  flex:0 0 auto;
  padding:14px 14px 8px;
  background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0)),var(--cream-2);
  border-bottom:1px solid var(--line);
  display:flex;flex-direction:column;align-items:center;gap:8px;
}
.mcv-hero-card{
  background:transparent;border:none;padding:0;cursor:pointer;
  position:relative;
  transform:rotate(-1deg);
}
.mcv-hero-tape{
  position:absolute;
  top:-8px;left:50%;
  transform:translateX(-50%) rotate(-3deg);
  width:56px;height:16px;
  background:repeating-linear-gradient(45deg,
    rgba(255,255,255,.45) 0,rgba(255,255,255,.45) 3px,
    transparent 3px,transparent 7px),var(--lilac-soft);
  box-shadow:0 1px 2px rgba(107,60,94,.15);
  z-index:2;
}
.mcv-hero-expand{
  position:absolute;
  bottom:6px;right:6px;
  background:rgba(107,60,94,.8);color:#fff;
  width:24px;height:24px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;line-height:1;
  backdrop-filter:blur(4px);
  -webkit-backdrop-filter:blur(4px);
}
.mcv-fmt-row{
  display:flex;align-items:center;gap:8px;margin-top:2px;
}
.mcv-fmt-eyebrow{
  font-family:var(--font-caveat),cursive;
  font-size:14px;color:var(--ink-soft);
  transform:rotate(-2deg);display:inline-block;
}
.mcv-fmt-tabs{
  display:inline-flex;
  background:#fff;border:1px solid var(--line);
  padding:2px;border-radius:999px;
  box-shadow:var(--shadow-sm);
}
.mcv-fmt-tab{
  border:none;background:transparent;
  color:var(--ink-soft);
  font-weight:600;font-size:9.5px;
  letter-spacing:.08em;text-transform:uppercase;
  padding:5px 10px;border-radius:999px;
  cursor:pointer;
}
.mcv-fmt-tab.on{
  background:var(--lilac-soft);color:var(--plum);
}

/* CONTENT ────────────────────────────── */
.mcv-content{
  flex:1 1 0;
  overflow-y:auto;
  padding:18px 18px 100px;
  -webkit-overflow-scrolling:touch;
}
.mcv-eyebrow{
  font-family:var(--font-caveat),cursive;
  color:var(--ink-soft);
  font-size:15px;letter-spacing:.01em;
  transform:rotate(-3deg);display:inline-block;
  transform-origin:left bottom;
}
.mcv-step-title{
  font-family:var(--font-patrick-hand),cursive;
  font-size:26px;color:var(--plum);
  margin:2px 0 14px;
  line-height:1;letter-spacing:-.01em;
  font-weight:600;
}
.mcv-stack{display:flex;flex-direction:column;gap:18px}
.mcv-label{
  display:block;
  font-family:var(--font-caveat),cursive;
  font-size:19px;color:var(--plum);
  line-height:1;margin:0 0 6px 4px;
  transform:rotate(-2deg);transform-origin:left bottom;
}
.mcv-label-tilt{transform:rotate(1deg)}
.mcv-label-row{
  display:flex;align-items:center;justify-content:space-between;
}
.mcv-field{
  width:100%;
  font-family:var(--font-patrick-hand),cursive;
  font-size:22px;color:var(--ink);
  background:transparent;
  border:none;border-bottom:1.5px dashed var(--line);
  padding:8px 4px 10px;
  outline:none;
  transition:border-color .15s;
  min-height:44px;
}
.mcv-field::placeholder{color:var(--ink-mute);font-style:italic}
.mcv-field:focus{
  border-bottom-color:var(--lilac-deep);
  border-bottom-style:solid;
}
.mcv-field[type="date"],
.mcv-field[type="time"]{
  font-size:18px;
}
.mcv-textarea{
  width:100%;
  font-family:var(--font-patrick-hand),cursive;
  font-size:18px;line-height:1.45;color:var(--ink);
  background:rgba(255,255,255,.5);
  border:1px solid var(--line);border-radius:10px;
  padding:10px 12px;outline:none;resize:vertical;
  min-height:64px;
}
.mcv-textarea:focus{border-color:var(--lilac)}
.mcv-pill{
  display:inline-flex;align-items:center;gap:5px;
  background:linear-gradient(135deg,var(--lilac-soft),#fff);
  border:1px solid var(--lilac);
  color:var(--lilac-deep);
  font-size:10.5px;font-weight:600;
  letter-spacing:.06em;text-transform:uppercase;
  padding:8px 12px;border-radius:999px;
  cursor:pointer;
  min-height:36px;
  transition:all .15s;
}
.mcv-pill:hover{background:var(--lilac);color:#fff}
.mcv-note{
  margin-top:10px;
  padding:10px 12px;
  background:var(--lilac-soft);
  border:1px dashed var(--lilac);
  border-radius:12px;
  font-family:var(--font-caveat),cursive;
  font-size:16px;color:var(--plum);
  line-height:1.3;
}

/* STEP: tipo ─────────────────────────── */
.mcv-tipo-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:8px;
}
.mcv-tipo{
  border:1px dashed var(--line);background:#fff;
  border-radius:12px;padding:10px 12px;
  cursor:pointer;text-align:left;
  font-family:var(--font-patrick-hand),cursive;
  display:flex;align-items:center;gap:10px;
  min-height:56px;
  box-shadow:var(--shadow-sm);
  transition:border-color .15s;
}
.mcv-tipo.on{
  border:1.8px solid var(--lilac-deep);
  background:var(--lilac-soft);
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-tipo-ico{font-size:22px;line-height:1;flex:0 0 auto}
.mcv-tipo-body{min-width:0;flex:1}
.mcv-tipo-label{
  font-size:15px;color:var(--ink);line-height:1.05;
}
.mcv-tipo.on .mcv-tipo-label{color:var(--plum)}
.mcv-tipo-hint{
  font-family:var(--font-caveat),cursive;
  font-size:11px;color:var(--ink-soft);
  margin-top:2px;line-height:1;
}
.mcv-tipo-soon{
  font-family:var(--font-caveat),cursive;
  font-size:10px;color:var(--ink-soft);
  border:1px solid var(--line);border-radius:7px;
  padding:0 4px;margin-left:3px;vertical-align:middle;white-space:nowrap;
}

/* STEP: quando — mode picker + date row ─ */
.mcv-mode-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:10px;
}
.mcv-mode{
  border:1px solid var(--line);background:#fff;
  border-radius:14px;padding:14px 12px;
  cursor:pointer;
  font-family:var(--font-patrick-hand),cursive;
  min-height:56px;text-align:left;
  transition:border-color .15s;
}
.mcv-mode.on{
  border:1.8px solid var(--lilac-deep);
  background:var(--lilac-soft);
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-mode-ico{font-size:22px;line-height:1;margin-bottom:4px}
.mcv-mode-label{
  font-size:17px;color:var(--ink);line-height:1;
}
.mcv-mode.on .mcv-mode-label{color:var(--plum)}
.mcv-date-row{
  display:grid;grid-template-columns:1.2fr 1fr;gap:14px;
}

/* STEP: fundo — search + grid + upload ── */
.mcv-search{
  position:relative;
  background:#fff;border:1.5px solid var(--line);
  border-radius:14px;
  display:flex;align-items:center;
  padding:4px 12px;
  box-shadow:var(--shadow-sm);
  color:var(--ink-soft);
}
.mcv-search svg{flex:0 0 auto;margin-right:8px}
.mcv-search-input{
  flex:1;min-width:0;
  border:none;outline:none;background:transparent;
  font-family:var(--font-patrick-hand),cursive;
  font-size:17px;color:var(--ink);
  padding:10px 0;line-height:1;
  min-height:44px;
}
.mcv-search-clear{
  flex:0 0 auto;
  background:var(--cream-2);border:none;cursor:pointer;
  color:var(--ink-soft);
  width:30px;height:30px;border-radius:50%;
  font-size:14px;line-height:1;
  display:flex;align-items:center;justify-content:center;
}
.mcv-fundo-grid{
  display:grid;grid-template-columns:repeat(2,1fr);gap:10px;
}
.mcv-tpl{
  background:#fff;
  border:1px dashed var(--line);
  border-radius:12px;padding:6px;cursor:pointer;
}
.mcv-tpl.on{
  border:1.8px solid var(--lilac-deep);
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-tpl-thumb{
  width:100%;aspect-ratio:2/3;
  border-radius:8px;
  border:1px solid var(--line);
  margin-bottom:5px;
  display:flex;align-items:center;justify-content:center;
}
.mcv-tpl-thumb-paper{
  background:#FFFCF8;
  background-image:radial-gradient(rgba(107,60,94,.06) 1px,transparent 1px);
  background-size:8px 8px;
  font-family:var(--font-caveat),cursive;
  font-size:14px;color:var(--ink-soft);
}
.mcv-tpl-label{
  font-family:var(--font-patrick-hand),cursive;
  font-size:13px;color:var(--ink);
  line-height:1;text-align:center;
}
.mcv-fundo-soon,.mcv-fundo-empty{
  grid-column:span 2;
  padding:24px 16px;text-align:center;
  background:var(--cream-2);border-radius:12px;
  border:1px dashed var(--line);
}
.mcv-fundo-soon-glyph,.mcv-fundo-empty-glyph{font-size:28px;margin-bottom:6px}
.mcv-fundo-soon-title,.mcv-fundo-empty-title{
  font-family:var(--font-patrick-hand),cursive;
  font-size:17px;color:var(--plum);
}
.mcv-fundo-soon-sub,.mcv-fundo-empty-sub{
  font-size:11px;color:var(--ink-soft);margin-top:4px;
}

/* upload tile */
.mcv-upload-empty{
  width:100%;
  background:rgba(255,255,255,.5);
  border:1.5px dashed var(--line);
  border-radius:14px;padding:14px 16px;
  cursor:pointer;text-align:left;
  display:flex;align-items:center;gap:12px;
  min-height:64px;
}
.mcv-upload-plus{
  width:40px;height:40px;border-radius:10px;
  border:1.5px dashed var(--lilac);
  display:flex;align-items:center;justify-content:center;
  font-size:20px;color:var(--lilac-deep);
  transform:rotate(-4deg);
  background:#fff;flex:0 0 auto;
}
.mcv-upload-empty-body{display:flex;flex-direction:column}
.mcv-upload-title{
  font-family:var(--font-patrick-hand),cursive;
  font-size:17px;color:var(--plum);line-height:1;
}
.mcv-upload-sub{
  font-size:10.5px;color:var(--ink-soft);margin-top:3px;
}
.mcv-upload-active{
  display:flex;align-items:center;gap:12px;
  background:#fff;
  border:1.5px solid var(--lilac-deep);
  border-radius:14px;padding:10px;
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-upload-thumb{
  width:50px;height:75px;border-radius:8px;
  background-color:var(--cream-2);
  background-size:cover;background-position:center;
  border:1px solid var(--line);flex:0 0 auto;
}
.mcv-upload-meta{flex:1;min-width:0}
.mcv-upload-clear{
  background:transparent;
  border:1px solid var(--coral-pink);
  color:var(--coral-pink);
  border-radius:999px;padding:8px 12px;
  font-weight:600;font-size:10px;
  letter-spacing:.08em;text-transform:uppercase;
  cursor:pointer;
  min-height:36px;
}

/* STEP: visual — carousels ─────────────── */
.mcv-carousel{
  display:flex;gap:10px;overflow-x:auto;
  padding:4px 0;
  scroll-snap-type:x mandatory;
  scrollbar-width:none;
  -webkit-overflow-scrolling:touch;
}
.mcv-carousel::-webkit-scrollbar{display:none}
.no-scrollbar{scrollbar-width:none}
.no-scrollbar::-webkit-scrollbar{display:none}
.mcv-pal{
  flex:0 0 auto;scroll-snap-align:start;
  background:#fff;border:1px solid var(--line);
  border-radius:14px;padding:8px;
  cursor:pointer;text-align:center;
  min-width:76px;
}
.mcv-pal.on{
  border:1.8px solid var(--lilac-deep);
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-pal-dots{
  display:flex;justify-content:center;gap:2px;margin-bottom:4px;
}
.mcv-pal-dot{
  width:12px;height:12px;border-radius:50%;
  border:1.5px solid #fff;
  box-shadow:0 0 0 1px var(--line);
}
.mcv-pal-label{
  font-family:var(--font-patrick-hand),cursive;
  font-size:13px;color:var(--ink);line-height:1;
}
.mcv-pal.on .mcv-pal-label{color:var(--plum)}
.mcv-pal-surprise{
  background:var(--lilac-soft);
  border:1px dashed var(--lilac);
}
.mcv-pal-surprise-glyph{font-size:18px;margin-bottom:2px;line-height:1}
.mcv-pal-surprise .mcv-pal-label{color:var(--plum)}
.mcv-font{
  flex:0 0 auto;scroll-snap-align:start;
  border:1px solid var(--line);background:#fff;
  border-radius:12px;padding:10px 14px;
  cursor:pointer;
  font-size:24px;line-height:1;color:var(--plum);
  min-height:48px;
  min-width:80px;
  white-space:nowrap;
}
.mcv-font.on{
  border:1.8px solid var(--lilac-deep);
  background:var(--lilac-soft);
  box-shadow:0 2px 6px rgba(107,60,94,.12);
}
.mcv-seg{
  display:flex;width:100%;
  background:var(--cream-2);padding:4px;border-radius:999px;gap:2px;
}
.mcv-seg-btn{
  flex:1;
  border:none;background:transparent;
  font-weight:600;font-size:11.5px;
  letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-soft);
  padding:10px 8px;border-radius:999px;
  cursor:pointer;
  min-height:44px;
  transition:all .15s;
}
.mcv-seg-btn.on{
  background:#fff;color:var(--plum);
  box-shadow:0 1px 3px rgba(107,60,94,.12);
}

/* FOOTER ─────────────────────────────── */
.mcv-footer{
  flex:0 0 auto;
  padding:12px 14px calc(env(safe-area-inset-bottom,0px) + 18px);
  background:rgba(255,255,255,.92);
  backdrop-filter:blur(14px);
  -webkit-backdrop-filter:blur(14px);
  border-top:1px solid var(--line);
  display:flex;gap:10px;align-items:center;
  z-index:8;
}
.mcv-footer-back{
  width:48px;height:48px;border-radius:14px;
  background:#fff;border:1px solid var(--line);
  color:var(--ink);font-size:22px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  flex:0 0 auto;
  font-family:var(--font-patrick-hand),cursive;
  line-height:1;
}
.mcv-footer-cta{
  flex:1;height:48px;border-radius:14px;
  background:var(--lilac);color:#fff;border:none;
  cursor:pointer;
  font-weight:700;font-size:13px;
  letter-spacing:.1em;text-transform:uppercase;
  box-shadow:var(--shadow-cta);
  display:flex;align-items:center;justify-content:center;gap:8px;
}
.mcv-footer-cta.is-last{
  background:var(--coral-pink);
  box-shadow:0 8px 20px rgba(231,143,167,.4);
}

/* MODAL ──────────────────────────────── */
.mcv-modal{
  position:fixed;inset:0;z-index:9999;
  background:rgba(40,24,36,.6);
  backdrop-filter:blur(12px);
  -webkit-backdrop-filter:blur(12px);
  display:flex;flex-direction:column;
  padding-top:calc(env(safe-area-inset-top,0px) + 12px);
  padding-bottom:calc(env(safe-area-inset-bottom,0px) + 8px);
  animation:mcv-fade .2s ease;
}
@keyframes mcv-fade{
  from{opacity:0}
  to{opacity:1}
}
.mcv-modal-header{
  flex:0 0 auto;padding:14px 18px;
  display:flex;align-items:center;gap:10px;
}
.mcv-modal-eyebrow{
  font-family:var(--font-caveat),cursive;
  font-size:22px;color:#fff;
  transform:rotate(-3deg);display:inline-block;
}
.mcv-modal-close{
  width:44px;height:44px;border-radius:50%;
  background:rgba(255,255,255,.2);color:#fff;
  border:none;cursor:pointer;
  font-size:22px;line-height:1;
  display:flex;align-items:center;justify-content:center;
}
.mcv-modal-tabs-row{
  flex:0 0 auto;display:flex;justify-content:center;
  padding:0 18px 14px;
}
.mcv-modal-tabs{
  display:inline-flex;background:rgba(255,255,255,.15);
  padding:4px;border-radius:999px;gap:2px;
}
.mcv-modal-tab{
  border:none;background:transparent;
  color:rgba(255,255,255,.9);
  font-weight:600;font-size:11px;
  letter-spacing:.08em;text-transform:uppercase;
  padding:12px 16px;border-radius:999px;
  cursor:pointer;
  min-height:44px;
}
.mcv-modal-tab.on{background:#fff;color:var(--plum)}
.mcv-modal-stage{
  flex:1;display:flex;align-items:center;justify-content:center;
  padding:0 24px;
}
.mcv-modal-preview{
  transform:rotate(-1.5deg);position:relative;
}
.mcv-modal-tape{
  position:absolute;
  top:-12px;left:50%;
  transform:translateX(-50%) rotate(-3deg);
  width:60px;height:18px;
  background:repeating-linear-gradient(45deg,
    rgba(255,255,255,.45) 0,rgba(255,255,255,.45) 3px,
    transparent 3px,transparent 7px),var(--lilac-soft);
  box-shadow:0 1px 3px rgba(0,0,0,.15);
}
.mcv-modal-bar{
  flex:0 0 auto;padding:14px 18px 8px;
  display:flex;gap:10px;
}
.mcv-modal-ghost,.mcv-modal-primary{
  flex:1;height:48px;border-radius:12px;
  border:none;cursor:pointer;
  font-weight:600;font-size:12px;
  letter-spacing:.08em;text-transform:uppercase;
}
.mcv-modal-ghost{background:#fff;color:var(--plum)}
.mcv-modal-primary{
  background:var(--lilac);color:#fff;
  font-weight:700;
  box-shadow:var(--shadow-cta);
}

@media (prefers-reduced-motion:reduce){
  .mcv-progress-fill,.mcv-progress-dot,.mcv-modal{
    transition:none;animation:none;
  }
}
`;
