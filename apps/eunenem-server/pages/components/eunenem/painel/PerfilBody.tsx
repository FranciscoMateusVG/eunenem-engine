
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useTweaks } from "@/components/eunenem/TweaksContext";
import { painelHref } from "@/lib/painelRoutes";
import {
  PERFIL_DEMO,
  PERFIL_EVENT_TYPES,
  PERFIL_RELATIONS,
} from "@/lib/mocks/perfil";
import type { PainelSectionBodyProps } from "@/PainelSectionPage";

// aperture-1z6xa — Editar Perfil body (content only).
//
// Renders inside PainelLayout (topbar + 520px shell + Tweaks come free), so
// this file is just the hero + the profile-edit form cards. Faithful to the
// "Editar Perfil" export: lilás "informações da página" (slug link + share
// row), pink "datas importantes" (chá + nascimento + tipo de evento), yellow
// "informações do neném" (nome obrigatório + seu nome + parentesco), blue
// "minha história" textarea (600-char cap), green "fotos da página" (3 upload
// slots reusing ImageSlot).
//
// Mock-first: every input is local React state seeded from PERFIL_DEMO. babyName
// + creatorName mirror into TweaksContext on save so the rest of the panel
// (header card greeting + "página da <nome>") tracks the edit live — but only
// on an explicit save, never per-keystroke, so the form feels like a draft.
// "salvar" is a mock with a 600ms fake latency then a sonner toast. There is no
// backend, no persistence: reload resets to PERFIL_DEMO.

const ico = {
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
    </svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  ),
  baby: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="9" r="5" />
      <path d="M9 9h.01M15 9h.01M10 12c.5.6 1.2 1 2 1s1.5-.4 2-1" />
      <path d="M5 21c1-3 4-5 7-5s6 2 7 5" />
    </svg>
  ),
  heart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
    </svg>
  ),
  camera: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  chev: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 10l5 5 5-5" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 6l-6 6 6 6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l4.5 4.5L19 7" />
    </svg>
  ),
  // aperture-ou9bp — tiny photo glyph for per-slot header tile + plus glyph
  // for the dropzone CTA circle.
  photo: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="M7 15.5l3.2-3.2a1.5 1.5 0 0 1 2.1 0L17 17" />
      <path d="M14.5 13l1.4-1.4a1.5 1.5 0 0 1 2.1 0L20.5 13.6" />
      <circle cx="9" cy="10" r="1.3" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 6v12M6 12h12" />
    </svg>
  ),
} as const;

type ChipVariant = "lilac" | "pink" | "yellow" | "blue" | "green";

function PerfilSection({
  icon,
  title,
  variant,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  variant: ChipVariant;
  children: React.ReactNode;
}) {
  return (
    <section className="perfil-card">
      <header className="perfil-card-head">
        <span className={`perfil-chip perfil-chip-${variant}`}>{icon}</span>
        <h2 className="perfil-card-title">{title}</h2>
      </header>
      <div className="perfil-card-body">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="perfil-field">
      <label className="perfil-field-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="perfil-req">*</span>}
      </label>
      {children}
      {hint && <span className="perfil-field-hint">{hint}</span>}
    </div>
  );
}

// aperture-ou9bp — single upload slot for the "fotos da página" 3-grid.
// Header row (pink mini-tile + plum label) over a dashed-border dropzone
// with a + circle + CTA. Stub upload only: file becomes a local
// URL.createObjectURL preview, no fetch.
function PhotoSlot({
  id,
  label,
  cta,
  toastLabel,
  file,
  onFile,
}: {
  id: string;
  label: string;
  cta: string;
  toastLabel: string;
  file: File | null;
  onFile: (file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Mint/revoke object URLs in sync with the chosen file. Revoking on
  // unmount + on swap keeps blob: URLs from leaking.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const openPicker = () => inputRef.current?.click();
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const filled = !!file && !!previewUrl;

  return (
    <div className="perfil-foto-slot">
      <div className="perfil-foto-header">
        <span className="perfil-foto-icon" aria-hidden="true">
          {ico.photo}
        </span>
        <span className="perfil-foto-label">{label}</span>
      </div>

      <div
        className={`perfil-foto-dropzone${filled ? " perfil-foto-dropzone--filled" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={cta}
        onClick={openPicker}
        onKeyDown={handleKey}
      >
        {filled ? (
          <img
            className="perfil-foto-preview"
            src={previewUrl ?? undefined}
            alt={`${toastLabel} — pré-visualização`}
          />
        ) : (
          <>
            <span className="perfil-foto-plus-circle" aria-hidden="true">
              {ico.plus}
            </span>
            <span className="perfil-foto-cta">{cta}</span>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        id={id}
        className="perfil-foto-input"
        type="file"
        accept="image/*"
        onChange={(e) => {
          const next = e.target.files?.[0] ?? null;
          if (next) {
            onFile(next);
            toast.success(`foto carregada — ${toastLabel}`);
          }
          // reset so picking the same file again still fires
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function PerfilBody({ slug }: PainelSectionBodyProps) {
  const { tweaks, setTweaks } = useTweaks();

  const [profileSlug, setProfileSlug] = useState(
    slug || PERFIL_DEMO.profileSlug,
  );
  const [babyName, setBabyName] = useState(
    tweaks.babyName || PERFIL_DEMO.babyName,
  );
  const [creatorName, setCreatorName] = useState(PERFIL_DEMO.creatorName);
  const [relation, setRelation] = useState(PERFIL_DEMO.relation);
  const [eventType, setEventType] = useState(PERFIL_DEMO.eventType);
  const [teaDate, setTeaDate] = useState(PERFIL_DEMO.teaDate);
  const [birthDate, setBirthDate] = useState(PERFIL_DEMO.birthDate);
  const [story, setStory] = useState(PERFIL_DEMO.story);
  const [saving, setSaving] = useState(false);

  // aperture-ou9bp — stub photo uploads. Each slot is independent state;
  // no fetch, no persistence, swap-on-pick + sonner toast only.
  const [fotoPerfil, setFotoPerfil] = useState<File | null>(null);
  const [fotoCapa, setFotoCapa] = useState<File | null>(null);
  const [fotoHistoria, setFotoHistoria] = useState<File | null>(null);


  const handleSave = () => {
    if (!babyName.trim()) {
      toast.error("Conta pra gente o nome do neném ♡");
      return;
    }
    setSaving(true);
    // Mock latency — no backend. On "save" we mirror the names into the
    // shared Tweaks state so the panel header (greeting + "página da <nome>")
    // tracks the edit, then confirm with a toast.
    setTimeout(() => {
      setTweaks({ babyName: babyName.trim() });
      setSaving(false);
      toast.success("Tudo salvo! Feito com carinho ♡");
    }, 600);
  };

  return (
    <div className="perfil-body">
      <div className="perfil-hero">
        <h1 className="perfil-hero-title">
          edite o <span className="hl">perfil</span> do seu&nbsp;neném
        </h1>
      </div>

      {/* 1 — Informações da página */}
      <PerfilSection icon={ico.user} title="informações da página" variant="lilac">
        <Field label="nome do perfil (link da página)" htmlFor="perfil-slug">
          <div className="perfil-input-prefix">
            <span className="perfil-prefix">{PERFIL_DEMO.shareBase}</span>
            <input
              id="perfil-slug"
              className="perfil-input perfil-input-slug"
              type="text"
              value={profileSlug}
              placeholder="seu-link"
              onChange={(e) =>
                setProfileSlug(
                  e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                )
              }
            />
          </div>
        </Field>

        <div className="perfil-share">
          <span className="perfil-share-eyebrow">link da página</span>
          <div className="perfil-share-row">
            <span className="perfil-share-url" title={`${PERFIL_DEMO.shareBase}${profileSlug}`}>
              {PERFIL_DEMO.shareBase}
              {profileSlug}
            </span>
            <button
              type="button"
              className="perfil-share-copy"
              onClick={() => {
                const link = `${PERFIL_DEMO.shareBase}${profileSlug}`;
                void navigator.clipboard
                  .writeText(link)
                  .then(() => toast.success("link copiado ♡"))
                  .catch(() => toast.error("não consegui copiar o link"));
              }}
              aria-label="Copiar link da página"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2.5" />
                <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
              </svg>
              <span>copiar</span>
            </button>
          </div>
        </div>
      </PerfilSection>

      {/* 2 + 3 — Two-column row at desktop (datas + neném) */}
      <div className="perfil-row-2">
      {/* 2 — Datas importantes */}
      <PerfilSection icon={ico.calendar} title="datas importantes" variant="pink">
        <Field label="data do chá" htmlFor="perfil-tea">
          <div className={`perfil-input perfil-date ${teaDate ? "" : "is-empty"}`}>
            <input
              id="perfil-tea"
              className="perfil-date-field"
              type="text"
              inputMode="numeric"
              value={teaDate}
              placeholder="dd/mm/aaaa"
              onChange={(e) => setTeaDate(e.target.value)}
            />
            <span className="perfil-date-actions">
              {teaDate && (
                <button
                  type="button"
                  className="perfil-date-clear"
                  onClick={() => setTeaDate("")}
                  aria-label="Limpar data do chá"
                >
                  {ico.x}
                </button>
              )}
              <span className="perfil-date-cal">{ico.calendar}</span>
            </span>
          </div>
        </Field>

        <Field label="data prevista de nascimento" htmlFor="perfil-birth">
          <div className={`perfil-input perfil-date ${birthDate ? "" : "is-empty"}`}>
            <input
              id="perfil-birth"
              className="perfil-date-field"
              type="text"
              inputMode="numeric"
              value={birthDate}
              placeholder="dd/mm/aaaa"
              onChange={(e) => setBirthDate(e.target.value)}
            />
            <span className="perfil-date-actions">
              {birthDate && (
                <button
                  type="button"
                  className="perfil-date-clear"
                  onClick={() => setBirthDate("")}
                  aria-label="Limpar data de nascimento"
                >
                  {ico.x}
                </button>
              )}
              <span className="perfil-date-cal">{ico.calendar}</span>
            </span>
          </div>
        </Field>

        <Field label="tipo de evento" htmlFor="perfil-event">
          <div className="perfil-select-wrap">
            <select
              id="perfil-event"
              className="perfil-input perfil-select"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            >
              {PERFIL_EVENT_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="perfil-select-chev">{ico.chev}</span>
          </div>
        </Field>
      </PerfilSection>

      {/* 3 — Informações do neném */}
      <PerfilSection icon={ico.baby} title="informações do neném" variant="yellow">
        <Field label="nome do neném" htmlFor="perfil-baby" required>
          <input
            id="perfil-baby"
            className="perfil-input"
            type="text"
            value={babyName}
            placeholder="ex: Helena"
            onChange={(e) => setBabyName(e.target.value)}
          />
        </Field>

        <Field label="seu nome" htmlFor="perfil-creator">
          <input
            id="perfil-creator"
            className="perfil-input"
            type="text"
            value={creatorName}
            placeholder="como te chamam"
            onChange={(e) => setCreatorName(e.target.value)}
          />
        </Field>

        <Field label="parentesco" htmlFor="perfil-relation">
          <div className="perfil-select-wrap">
            <select
              id="perfil-relation"
              className="perfil-input perfil-select"
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
            >
              {PERFIL_RELATIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="perfil-select-chev">{ico.chev}</span>
          </div>
        </Field>
      </PerfilSection>
      </div>

      {/* 4 — Minha história */}
      <PerfilSection icon={ico.heart} title="minha história" variant="blue">
        <Field
          label="conte um pouquinho"
          htmlFor="perfil-story"
          hint={`${story.length}/${PERFIL_DEMO.storyMax} caracteres`}
        >
          <textarea
            id="perfil-story"
            className="perfil-input perfil-textarea"
            value={story}
            placeholder="conte sua história… como foi a notícia, planos, sonhos, recados pra quem visita a página ♡"
            rows={6}
            onChange={(e) =>
              setStory(e.target.value.slice(0, PERFIL_DEMO.storyMax))
            }
          />
        </Field>
      </PerfilSection>

      {/* 5 — Fotos da página (aperture-ou9bp) */}
      <PerfilSection icon={ico.camera} title="fotos da página" variant="pink">
        <div className="perfil-fotos-grid">
          <PhotoSlot
            id="perfil-foto-avatar"
            label="Foto de Perfil"
            cta="escolher foto para Perfil"
            toastLabel="Perfil"
            file={fotoPerfil}
            onFile={setFotoPerfil}
          />
          <PhotoSlot
            id="perfil-foto-capa"
            label="Foto de Capa"
            cta="escolher foto para Capa"
            toastLabel="Capa"
            file={fotoCapa}
            onFile={setFotoCapa}
          />
          <PhotoSlot
            id="perfil-foto-historia"
            label="Foto de História"
            cta="escolher foto para História"
            toastLabel="História"
            file={fotoHistoria}
            onFile={setFotoHistoria}
          />
        </div>
      </PerfilSection>

      <div className="perfil-actions">
        <a className="perfil-btn perfil-btn-ghost" href={painelHref(profileSlug)}>
          {ico.back}
          <span>voltar para a minha área</span>
        </a>
        <button
          type="button"
          className="perfil-btn perfil-btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <>
              <span className="perfil-spinner" aria-hidden="true" /> salvando…
            </>
          ) : (
            <>
              {ico.check}
              <span>salvar alterações</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
