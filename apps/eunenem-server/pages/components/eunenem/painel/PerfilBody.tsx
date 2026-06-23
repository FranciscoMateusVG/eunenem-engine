
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useTweaks } from "@/components/eunenem/TweaksContext";
import { trpc } from "@/lib/trpc";
import { painelHref } from "@/lib/painelRoutes";
import { PERFIL_RELATIONS } from "@/lib/mocks/perfil";
import type { PainelSectionBodyProps } from "@/PainelSectionPage";

// aperture-1z6xa / aperture-bnj0z — Editar Perfil body (content only).
//
// V1 (bnj0z): wired to the real tRPC perfil-router (R3 aperture-cdo69).
//   • load  → trpc.perfil.getPerfil populates the form on mount (real
//     loading/error states; no more PERFIL_DEMO snapshot).
//   • save  → trpc.perfil.atualizar persists; toast fires only after the
//     mutation resolves. RELOADING THE PAGE PERSISTS (data comes from the DB).
//   • eventType uses the canonical TipoEvento slugs from the contract as the
//     source of truth (NOT the old mock labels) — the <select> stores slugs.
//   • babyName/creatorName still mirror into TweaksContext (header greeting).
//
// BOUNDARIES (kept out of V1 on purpose):
//   • slug is READ-ONLY here — inline availability + editing is V2 (e21v2).
//   • photo slots stay local-preview stubs — presigned upload is V4 (w4afb).
//     Existing photo keys from getPerfil are preserved on save (passed back to
//     atualizar) so V1 never wipes them.

const SHARE_BASE = "eunenem.com/";
const STORY_MAX = 600;

// Canonical celebration slugs — kept in sync with the contract enum
// (TipoEventoPerfilSchema, mirror of the Evento BC's TipoEvento). The form
// stores the SLUG; the label is display-only. Selectable set matches the
// convite selector (aperture-irowp): chá revelação is not offered as a new
// choice, but is labelled if an existing profile already carries it.
type PerfilEventTypeSlug =
  | "cha-bebe"
  | "cha-fraldas"
  | "cha-surpresa"
  | "cha-revelacao"
  | "batizado"
  | "aniversario";

const EVENT_TYPE_LABELS: Record<PerfilEventTypeSlug, string> = {
  "cha-bebe": "Chá de bebê",
  "cha-fraldas": "Chá de fraldas",
  "cha-surpresa": "Chá surpresa",
  "cha-revelacao": "Chá revelação",
  batizado: "Batizado",
  aniversario: "Aniversário",
};

const SELECTABLE_EVENT_TYPES: PerfilEventTypeSlug[] = [
  "cha-bebe",
  "cha-fraldas",
  "cha-surpresa",
  "aniversario",
  "batizado",
];

// dd/mm/aaaa ⇄ ISO. The backend stores dates and `getPerfil` returns ISO
// strings; `atualizar` accepts an ISO string (z.coerce.date coerces it).
// We read/write UTC components so the displayed day never shifts by timezone.
const BR_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function brToISO(br: string): string | null {
  const m = br.trim().match(BR_DATE_RE);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Reject overflow dates like 31/02/2026 (JS would roll them forward).
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.toISOString();
}

function isoToBR(iso: string | null): string {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getUTCFullYear()}`;
}

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
// URL.createObjectURL preview, no fetch. (Real presigned upload is V4.)
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
  const utils = trpc.useUtils();

  const [profileSlug, setProfileSlug] = useState(slug || "");
  const [babyName, setBabyName] = useState(tweaks.babyName || "");
  const [creatorName, setCreatorName] = useState("");
  const [relation, setRelation] = useState("");
  const [eventType, setEventType] = useState<PerfilEventTypeSlug | "">("");
  const [teaDate, setTeaDate] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [story, setStory] = useState("");

  // aperture-ou9bp — local-only photo previews (real upload is V4). Existing
  // keys from getPerfil are held so save round-trips them unchanged.
  const [fotoPerfil, setFotoPerfil] = useState<File | null>(null);
  const [fotoCapa, setFotoCapa] = useState<File | null>(null);
  const [fotoHistoria, setFotoHistoria] = useState<File | null>(null);
  const fotoKeys = useRef<{
    perfil: string | null;
    capa: string | null;
    historia: string | null;
  }>({ perfil: null, capa: null, historia: null });

  const perfilQuery = trpc.perfil.getPerfil.useQuery(undefined, {
    staleTime: 30_000,
  });
  const hydrated = useRef(false);

  // Hydrate the form once from the real profile. Subsequent saves keep local
  // state authoritative (it already reflects the edit), so we don't re-seed.
  useEffect(() => {
    const d = perfilQuery.data;
    if (!d || hydrated.current) return;
    setProfileSlug(d.slug || slug || "");
    setBabyName(d.nomeBebe ?? "");
    setCreatorName(d.creatorName ?? "");
    setRelation(d.relacao ?? "");
    setEventType((d.tipoEvento as PerfilEventTypeSlug | null) ?? "");
    setTeaDate(isoToBR(d.dataEvento));
    setBirthDate(isoToBR(d.dataNascimento));
    setStory(d.historia ?? "");
    fotoKeys.current = {
      perfil: d.fotoPerfil,
      capa: d.fotoCapa,
      historia: d.fotoHistoria,
    };
    setTweaks({ babyName: d.nomeBebe ?? "" });
    hydrated.current = true;
  }, [perfilQuery.data, slug, setTweaks]);

  const atualizar = trpc.perfil.atualizar.useMutation({
    onSuccess: (updated) => {
      fotoKeys.current = {
        perfil: updated.fotoPerfil,
        capa: updated.fotoCapa,
        historia: updated.fotoHistoria,
      };
      setTweaks({ babyName: updated.nomeBebe ?? babyName.trim() });
      utils.perfil.getPerfil.setData(undefined, updated);
      toast.success("Tudo salvo! Feito com carinho ♡");
    },
    onError: (err) => {
      toast.error(err.message || "não consegui salvar — tenta de novo?");
    },
  });

  const handleSave = () => {
    if (!babyName.trim()) {
      toast.error("Conta pra gente o nome do neném ♡");
      return;
    }
    if (!creatorName.trim()) {
      toast.error("Conta pra gente o seu nome ♡");
      return;
    }
    const dataEvento = teaDate.trim() ? brToISO(teaDate) : null;
    if (teaDate.trim() && !dataEvento) {
      toast.error("Data do chá inválida — use dd/mm/aaaa");
      return;
    }
    const dataNascimento = birthDate.trim() ? brToISO(birthDate) : null;
    if (birthDate.trim() && !dataNascimento) {
      toast.error("Data de nascimento inválida — use dd/mm/aaaa");
      return;
    }
    atualizar.mutate({
      nomeExibicao: creatorName.trim(),
      nomeBebe: babyName.trim(),
      relacao: relation.trim() || null,
      historia: story.trim() || null,
      dataNascimento,
      tipoEvento: eventType || null,
      dataEvento,
      fotoPerfilKey: fotoKeys.current.perfil,
      fotoCapaKey: fotoKeys.current.capa,
      fotoHistoriaKey: fotoKeys.current.historia,
    });
  };

  const saving = atualizar.isPending;

  // Event-type options: the 5 selectable slugs, plus the currently-loaded
  // value if it isn't one of them (so an existing chá-revelação still shows
  // and isn't silently dropped on the next save).
  const eventOptions: PerfilEventTypeSlug[] =
    eventType && !SELECTABLE_EVENT_TYPES.includes(eventType)
      ? [eventType, ...SELECTABLE_EVENT_TYPES]
      : SELECTABLE_EVENT_TYPES;

  // ── Loading / error states (real, replacing the demo snapshot) ──
  if (perfilQuery.isLoading) {
    return (
      <div className="perfil-body">
        <div className="perfil-hero">
          <h1 className="perfil-hero-title">
            carregando o seu <span className="hl">perfil</span>…
          </h1>
        </div>
        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
          <span className="perfil-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (perfilQuery.error) {
    return (
      <div className="perfil-body">
        <div className="perfil-hero">
          <h1 className="perfil-hero-title">
            ops, algo <span className="hl">não carregou</span>
          </h1>
        </div>
        <div style={{ textAlign: "center", padding: "16px 0 32px" }}>
          <p style={{ color: "var(--ink-soft)", marginBottom: 16 }}>
            não consegui carregar o seu perfil agora.
          </p>
          <button
            type="button"
            className="perfil-btn perfil-btn-primary"
            onClick={() => void perfilQuery.refetch()}
          >
            <span>tentar de novo</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="perfil-body">
      <div className="perfil-hero">
        <h1 className="perfil-hero-title">
          edite o <span className="hl">perfil</span> do seu&nbsp;neném
        </h1>
      </div>

      {/* 1 — Informações da página */}
      <PerfilSection icon={ico.user} title="informações da página" variant="lilac">
        <Field
          label="nome do perfil (link da página)"
          htmlFor="perfil-slug"
          hint="a edição do link chega em breve ♡"
        >
          <div className="perfil-input-prefix">
            <span className="perfil-prefix">{SHARE_BASE}</span>
            <input
              id="perfil-slug"
              className="perfil-input perfil-input-slug"
              type="text"
              value={profileSlug}
              placeholder="seu-link"
              readOnly
              aria-readonly="true"
            />
          </div>
        </Field>

        <div className="perfil-share">
          <span className="perfil-share-eyebrow">link da página</span>
          <div className="perfil-share-row">
            <span className="perfil-share-url" title={`${SHARE_BASE}${profileSlug}`}>
              {SHARE_BASE}
              {profileSlug}
            </span>
            <button
              type="button"
              className="perfil-share-copy"
              onClick={() => {
                const link = `${SHARE_BASE}${profileSlug}`;
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
              onChange={(e) =>
                setEventType(e.target.value as PerfilEventTypeSlug | "")
              }
            >
              <option value="">selecione o tipo</option>
              {eventOptions.map((slug) => (
                <option key={slug} value={slug}>
                  {EVENT_TYPE_LABELS[slug]}
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

        <Field label="seu nome" htmlFor="perfil-creator" required>
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
              <option value="">selecione</option>
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
          hint={`${story.length}/${STORY_MAX} caracteres`}
        >
          <textarea
            id="perfil-story"
            className="perfil-input perfil-textarea"
            value={story}
            placeholder="conte sua história… como foi a notícia, planos, sonhos, recados pra quem visita a página ♡"
            rows={6}
            onChange={(e) => setStory(e.target.value.slice(0, STORY_MAX))}
          />
        </Field>
      </PerfilSection>

      {/* 5 — Fotos da página (aperture-ou9bp; upload real = V4) */}
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
