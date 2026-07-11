
import { useEffect, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import { toast } from "sonner";

import { useTweaks } from "@/components/eunenem/TweaksContext";
import { trpc } from "@/lib/trpc";
import type { Genero } from "@/lib/concordancia";
import { paginaShareDisplayPath, paginaShareDisplayPrefix, paginaShareUrl } from "@/lib/pagina-share";
import { useCampanhaSlugInfoRota } from "@/lib/campanhas";
import { painelHref } from "@/lib/painelRoutes";
import { useCampanhaEscrita } from "@/lib/campanha-escrita";
import { useCampanhaRota } from "@/lib/campanha-rota";
import { PERFIL_RELATIONS } from "@/lib/mocks/perfil";
import { sendEvent } from "@/lib/analytics";
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

// aperture-1yx1n / ugttj — legacy "eunenem.com/" SHARE_BASE removed: it was
// a dead link (wrong domain AND wrong path). All share/display URLs come
// from the pagina-share seam now (pages/lib/pagina-share.ts).
const STORY_MAX = 600;

// Slug format mirror of the campanha's OWN slug (CAMPANHA_SLUG_REGEX in
// campanhas-router.ts): starts with a letter, 3–60 chars, lowercase
// letters / digits / hyphen. Client-side gate before we even ask the
// server for availability. NOT the usuario slug regex ({2,29}) — this
// component edits campanhas.slug (the campanha's own link), which is a
// varchar(60) with its own bounds.
const SLUG_RE = /^[a-z][a-z0-9-]{2,59}$/;

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

// aperture-neiwx — same options as OnboardingWizard's GENEROS (mirror, not
// imported: OnboardingWizard doesn't export it, and it's 4 lines).
const GENEROS: ReadonlyArray<{ value: Genero; label: string }> = [
  { value: "menina", label: "Menina" },
  { value: "menino", label: "Menino" },
  { value: "surpresa", label: "Ainda é surpresa ✨" },
  { value: "neutro", label: "Prefiro não dizer" },
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

// aperture-rbbpw — numeric dd/mm/aaaa mask: keep digits only, cap at 8, and
// auto-insert the slashes. Free text like "bvjvhb" can never reach state.
function maskBRDate(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += "/" + digits.slice(2, 4);
  if (digits.length > 4) out += "/" + digits.slice(4, 8);
  return out;
}

// BR (dd/mm/aaaa) <-> native <input type="date"> value (yyyy-mm-dd).
function brToInputValue(br: string): string {
  const m = br.trim().match(BR_DATE_RE);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function inputValueToBR(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
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

// aperture-w4afb (V4) — per-slot photo config. Aspect is LOCKED in the cropper
// so the creator sees exactly the crop that will show. Slot keys match the
// contract's emitirUrlUploadFoto slot enum ('perfil'|'capa'|'historia').
const SLOT_CONFIG = {
  perfil: { label: "Foto de Perfil", cta: "escolher foto para Perfil", aspect: 1 },
  capa: { label: "Foto de Capa", cta: "escolher foto para Capa", aspect: 5 / 4 },
  historia: { label: "Foto de História", cta: "escolher foto para História", aspect: 7 / 8 },
} as const;
type FotoSlot = keyof typeof SLOT_CONFIG;
// Matches the contract's CONTENT_TYPES_PERMITIDOS. We always export JPEG from
// the cropper, but the type stays a union to match emitirUrlUploadFoto's input.
type FotoContentType = "image/jpeg" | "image/png" | "image/webp";

type CropArea = { x: number; y: number; width: number; height: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", () => reject(new Error("falha ao carregar imagem")));
    img.src = src;
  });
}

// Draw the cropped region to a canvas → JPEG (always an allowed content-type;
// transparency isn't needed for these photos).
async function cropToBlob(imageSrc: string, area: CropArea): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(area.width));
  canvas.height = Math.max(1, Math.round(area.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponível");
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("falha ao recortar"))),
      "image/jpeg",
      0.9,
    ),
  );
}

// Locked-aspect cropper modal (react-easy-crop) → returns the cropped JPEG blob.
function CropperModal({
  file,
  aspect,
  label,
  onCancel,
  onConfirm,
}: {
  file: File;
  aspect: number;
  label: string;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropArea | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const confirm = async () => {
    if (!imageSrc || !area) return;
    setWorking(true);
    try {
      onConfirm(await cropToBlob(imageSrc, area));
    } catch {
      toast.error("não consegui recortar a imagem — tenta outra?");
      setWorking(false);
    }
  };

  return (
    <div
      className="perfil-cropper-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={`Recortar ${label}`}
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,26,26,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 80,
        padding: 16,
      }}
    >
      <div
        className="perfil-cropper-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--paper)",
          borderRadius: 18,
          padding: 16,
          width: "min(440px, 100%)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-patrick-hand), cursive",
            fontSize: 20,
            color: "var(--plum)",
            marginBottom: 10,
          }}
        >
          recortar {label.toLowerCase()}
        </div>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: 300,
            background: "#1a1a1a",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {imageSrc && (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={aspect}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, areaPixels) => setArea(areaPixels)}
            />
          )}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "14px 0",
            fontSize: 12,
            color: "var(--ink-soft)",
          }}
        >
          zoom
          <input
            type="range"
            min={1}
            max={3}
            step={0.02}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="zoom"
            style={{ flex: 1 }}
          />
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="perfil-btn perfil-btn-ghost"
            onClick={onCancel}
            disabled={working}
          >
            <span>cancelar</span>
          </button>
          <button
            type="button"
            className="perfil-btn perfil-btn-primary"
            onClick={confirm}
            disabled={working || !area}
          >
            {working ? (
              <>
                <span className="perfil-spinner" aria-hidden="true" /> recortando…
              </>
            ) : (
              <span>usar foto</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// aperture-w4afb — single photo slot: shows the current photo (or an empty
// CTA), opens the cropper on pick, then hands the cropped blob to onUpload
// (presigned PUT + persist). Per-slot locked aspect from SLOT_CONFIG.
function PhotoSlot({
  slot,
  displayUrl,
  onUpload,
}: {
  slot: FotoSlot;
  displayUrl: string | null;
  onUpload: (slot: FotoSlot, blob: Blob, contentType: FotoContentType) => Promise<void>;
}) {
  const cfg = SLOT_CONFIG[slot];
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPicker = () => inputRef.current?.click();
  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const onCropped = async (blob: Blob) => {
    setPendingFile(null);
    setUploading(true);
    setError(null);
    try {
      await onUpload(slot, blob, "image/jpeg");
    } catch {
      setError("não consegui enviar a foto — tenta de novo?");
    } finally {
      setUploading(false);
    }
  };

  const filled = !!displayUrl;

  return (
    <div className="perfil-foto-slot">
      <div className="perfil-foto-header">
        <span className="perfil-foto-icon" aria-hidden="true">
          {ico.photo}
        </span>
        <span className="perfil-foto-label">{cfg.label}</span>
      </div>

      <div
        className={`perfil-foto-dropzone${filled ? " perfil-foto-dropzone--filled" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={cfg.cta}
        onClick={openPicker}
        onKeyDown={handleKey}
        style={{ aspectRatio: String(cfg.aspect), position: "relative" }}
      >
        {uploading ? (
          <span className="perfil-spinner" aria-hidden="true" />
        ) : filled ? (
          <img
            className="perfil-foto-preview"
            src={displayUrl ?? undefined}
            alt={`${cfg.label} — atual`}
          />
        ) : (
          <>
            <span className="perfil-foto-plus-circle" aria-hidden="true">
              {ico.plus}
            </span>
            <span className="perfil-foto-cta">{cfg.cta}</span>
          </>
        )}
      </div>

      {error && (
        <span
          className="perfil-field-hint"
          role="alert"
          style={{ color: "var(--coral-pink)", fontWeight: 600 }}
        >
          {error}
        </span>
      )}
      {filled && !uploading && (
        <button
          type="button"
          className="perfil-foto-replace"
          onClick={openPicker}
          style={{
            marginTop: 8,
            background: "none",
            border: "none",
            color: "var(--lilac-deep)",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          trocar foto
        </button>
      )}

      <input
        ref={inputRef}
        className="perfil-foto-input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          if (f) setPendingFile(f);
          e.target.value = "";
        }}
      />

      {pendingFile && (
        <CropperModal
          file={pendingFile}
          aspect={cfg.aspect}
          label={cfg.label}
          onCancel={() => setPendingFile(null)}
          onConfirm={onCropped}
        />
      )}
    </div>
  );
}

// aperture-e21v2 (V2) / aperture (1-troca) — CAMPANHA slug edit UX (not the
// usuario slug — that's account-wide and out of scope here). Inline
// availability (debounced) via campanhas.validarSlug, save via
// campanhas.definirSlug with graceful inline errors (BAD_REQUEST codes
// never surface as a 500), and a confirm step warning both that changing
// the slug breaks already-shared links AND that this is the campanha's
// ONE allowed change via this screen (origem: 'perfil' consumes it — the
// SetupCampanhaWizard's own definirSlug call, origem: 'setup', does not).
// currentSlug may be "" when the campanha has no slug of its own yet
// (falls back to the /c/<uuid> public link shown in the "copiar link"
// block below, outside this component).
function SlugEditor({
  idCampanha,
  currentSlug,
  onChanged,
}: {
  idCampanha: string;
  currentSlug: string;
  onChanged: (slug: string) => void;
}) {
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState(currentSlug);
  const [confirming, setConfirming] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Re-sync when the saved slug changes underneath (parent hydration).
  useEffect(() => {
    setDraft(currentSlug);
    setConfirming(false);
    setServerError(null);
  }, [currentSlug]);

  const dirty = draft !== currentSlug;
  const formatOk = SLUG_RE.test(draft);

  // Debounce the availability check so it doesn't fire on every keystroke.
  const [debounced, setDebounced] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft), 400);
    return () => clearTimeout(t);
  }, [draft]);

  const disponibilidade = trpc.campanhas.validarSlug.useQuery(
    { idCampanha, slug: debounced },
    { enabled: dirty && formatOk && debounced === draft, staleTime: 0, retry: false },
  );

  const definirSlug = trpc.campanhas.definirSlug.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setServerError(null);
      // aperture — campanhas.list is the cache backing both campanhaSlug
      // (share link display) and slugJaAlterado (this editor's own
      // visibility gate) — invalidating it is what makes the editor
      // disappear right after this, the ONE allowed, save.
      void utils.campanhas.list.invalidate();
      toast.success("link da página atualizado ♡");
      onChanged(draft);
    },
    onError: (err) => {
      setConfirming(false);
      const msg = err.message || "";
      if (msg === "slug_em_uso") {
        setServerError("esse endereço já está em uso — escolha outro ♡");
      } else if (msg === "slug_reservado") {
        setServerError("esse endereço é reservado — escolha outro ♡");
      } else if (msg === "slug_formato_invalido") {
        setServerError(
          "formato inválido: 3–60 caracteres, começa com letra, só a–z, números e hífen",
        );
      } else if (msg === "slug_ja_alterado") {
        setServerError("você já trocou o link dessa página uma vez — essa troca não pode ser feita de novo ♡");
      } else {
        setServerError(msg || "não consegui salvar o link — tenta de novo?");
      }
    },
  });

  let status: { text: string; tone: "ok" | "bad" | "muted" };
  if (serverError) {
    status = { text: serverError, tone: "bad" };
  } else if (!dirty) {
    status = {
      text: "esse é o endereço público da sua página — você só pode trocar uma vez",
      tone: "muted",
    };
  } else if (!formatOk) {
    status = {
      text: "3–60 caracteres, começa com letra, só a–z, números e hífen",
      tone: "bad",
    };
  } else if (disponibilidade.isFetching || debounced !== draft) {
    status = { text: "verificando disponibilidade…", tone: "muted" };
  } else if (disponibilidade.data?.disponivel) {
    status = { text: "disponível ♡", tone: "ok" };
  } else if (disponibilidade.data?.motivo === "em_uso") {
    status = { text: "esse endereço já está em uso", tone: "bad" };
  } else if (disponibilidade.data?.motivo === "reservado") {
    status = { text: "esse endereço é reservado", tone: "bad" };
  } else {
    status = { text: "formato inválido", tone: "bad" };
  }

  const canSave =
    dirty &&
    formatOk &&
    disponibilidade.data?.disponivel === true &&
    !definirSlug.isPending;
  const toneColor =
    status.tone === "ok"
      ? "var(--lilac-deep)"
      : status.tone === "bad"
        ? "var(--coral-pink)"
        : "var(--ink-soft)";

  return (
    <Field label="nome do perfil (link da página)" htmlFor="perfil-slug">
      <div className="perfil-input-prefix">
        <span className="perfil-prefix">{paginaShareDisplayPrefix()}</span>
        <input
          id="perfil-slug"
          className="perfil-input perfil-input-slug"
          type="text"
          value={draft}
          placeholder="seu-link"
          onChange={(e) => {
            setServerError(null);
            setConfirming(false);
            setDraft(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
          }}
        />
      </div>

      <span
        className="perfil-field-hint"
        role={status.tone === "bad" ? "alert" : undefined}
        style={{ color: toneColor, fontWeight: status.tone === "muted" ? 400 : 600 }}
      >
        {status.text}
      </span>

      {dirty && (
        <div style={{ marginTop: 8 }}>
          {confirming ? (
            <div
              role="alert"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "12px 14px",
                borderRadius: 12,
                background: "var(--cream)",
                border: "1px dashed var(--line)",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--ink)" }}>
                trocar o link vai <strong>quebrar os links antigos</strong> que
                você já compartilhou{currentSlug ? <> (<code>{paginaShareDisplayPrefix()}{currentSlug}</code>)</> : null}, e{" "}
                <strong>só pode ser feito uma vez</strong>. tem certeza?
              </span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="perfil-btn perfil-btn-primary"
                  disabled={definirSlug.isPending}
                  onClick={() => definirSlug.mutate({ idCampanha, slug: draft, origem: "perfil" })}
                >
                  {definirSlug.isPending ? (
                    <>
                      <span className="perfil-spinner" aria-hidden="true" /> salvando…
                    </>
                  ) : (
                    <span>sim, trocar o link</span>
                  )}
                </button>
                <button
                  type="button"
                  className="perfil-btn perfil-btn-ghost"
                  disabled={definirSlug.isPending}
                  onClick={() => {
                    setConfirming(false);
                    setDraft(currentSlug);
                  }}
                >
                  <span>cancelar</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="perfil-btn perfil-btn-primary"
              disabled={!canSave}
              onClick={() => setConfirming(true)}
            >
              {ico.check}
              <span>salvar novo link</span>
            </button>
          )}
        </div>
      )}
    </Field>
  );
}

// aperture-rbbpw — decent date input. The masked text field is the primary
// path (numeric dd/mm/aaaa, no free text); the calendar icon is a real button
// that opens the native date picker for zero-typing selection.
function PerfilDateField({
  id,
  value,
  onChange,
  clearLabel,
  calLabel,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  clearLabel: string;
  calLabel: string;
}) {
  const dateRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    const el = dateRef.current as
      | (HTMLInputElement & { showPicker?: () => void })
      | null;
    if (!el) return;
    try {
      el.showPicker?.();
    } catch {
      // Older browsers without showPicker(): the masked field still works.
    }
  };
  return (
    <div className={`perfil-input perfil-date ${value ? "" : "is-empty"}`}>
      <input
        id={id}
        className="perfil-date-field"
        type="text"
        inputMode="numeric"
        value={value}
        placeholder="dd/mm/aaaa"
        maxLength={10}
        onChange={(e) => onChange(maskBRDate(e.target.value))}
      />
      <span className="perfil-date-actions">
        {value && (
          <button
            type="button"
            className="perfil-date-clear"
            onClick={() => onChange("")}
            aria-label={clearLabel}
          >
            {ico.x}
          </button>
        )}
        <span className="perfil-date-cal-wrap">
          <button
            type="button"
            className="perfil-date-cal"
            onClick={openPicker}
            aria-label={calLabel}
          >
            {ico.calendar}
          </button>
          <input
            ref={dateRef}
            type="date"
            className="perfil-date-native"
            tabIndex={-1}
            aria-hidden="true"
            value={brToInputValue(value)}
            onChange={(e) => onChange(inputValueToBR(e.target.value))}
          />
        </span>
      </span>
    </div>
  );
}

export function PerfilBody({ slug }: PainelSectionBodyProps) {
  const idCampanha = useCampanhaRota();
  // aperture-qmaoi (fblrt W2-c1) — WRITE target: rota ?? session-default
  // (oldest). Bare /painel/:slug saves now address the default campanha's
  // perfil via perfilCampanha.atualizar instead of feeding the legacy
  // perfil.atualizar baby-half (Rex's hsxim shed prerequisite). READS keep the
  // rota-only split: bare URLs hydrate from perfil.getPerfil, whose shim reads
  // the oldest campanha — the same rows these writes now target.
  const idCampanhaEscrita = useCampanhaEscrita();
  // aperture-2v91z — the route campanha's pretty slug for the share row.
  // aperture (1-troca) — slugJaAlterado gates whether the SlugEditor
  // renders at all (see the render below).
  const { campanhaSlug: campanhaSlugRota, slugJaAlterado } = useCampanhaSlugInfoRota();
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

  // aperture-w4afb (V4) — photo display URLs (seeded from getPerfil on hydrate;
  // set to the presigned publicUrl right after an upload). fotoKeys holds the
  // objectKeys persisted via atualizar.
  const [fotoUrls, setFotoUrls] = useState<{
    perfil: string | null;
    capa: string | null;
    historia: string | null;
  }>({ perfil: null, capa: null, historia: null });
  const fotoKeys = useRef<{
    perfil: string | null;
    capa: string | null;
    historia: string | null;
  }>({ perfil: null, capa: null, historia: null });

  // aperture-7sb1h — genero is wizard-captured; this form now also lets the
  // user edit it. perfil.atualizar is WHOLE-CONTENT replacement, so this state
  // is seeded from the loaded value (same as babyName/relation/eventType) and
  // sent back on every save — omitting it would WIPE the stored value.
  const [genero, setGenero] = useState<Genero | "">("");

  const perfilQuery = trpc.perfil.getPerfil.useQuery(undefined, {
    staleTime: 30_000,
  });
  // aperture-1yx1n — route decides which perfil: /c/:id → perfilCampanha.*,
  // bare → user-level (transitional shim repoints to oldest). Mode B loads the
  // baby-half from the ROUTE campanha; the USER-half (creatorName, slug) still
  // comes from perfil.getPerfil. Hook is unconditional (react-hooks rules) —
  // `enabled` gates the fetch on bare URLs.
  const perfilCampanhaQuery = trpc.perfilCampanha.get.useQuery(
    { idCampanha: idCampanha ?? "" },
    { enabled: Boolean(idCampanha), staleTime: 30_000 },
  );
  const hydrated = useRef(false);

  // aperture-1yx1n — Mode-B echo source: getPerfil's OWN DTO, held verbatim so
  // the user-level save can echo the USER-level baby-half back untouched (see
  // handleSaveCampanha for the clobber rationale). Refreshed from
  // perfil.atualizar's round-trip response — same discipline as the genero
  // state (aperture-7sb1h). creatorNameSaved is the skip-when-unchanged baseline.
  const perfilEchoRef = useRef<typeof perfilQuery.data>(undefined);
  const creatorNameSaved = useRef<string | null>(null);

  // Hydrate the form once from the real profile. Subsequent saves keep local
  // state authoritative (it already reflects the edit), so we don't re-seed.
  useEffect(() => {
    const d = perfilQuery.data;
    if (!d || hydrated.current) return;
    // aperture-1yx1n — Mode B: baby-half hydrates from the ROUTE campanha's
    // perfil; gate until BOTH queries resolve so we hydrate once, fully.
    const c = idCampanha ? perfilCampanhaQuery.data : undefined;
    if (idCampanha && !c) return;
    // USER-half — always from perfil.getPerfil (per-user fields).
    setProfileSlug(d.slug || slug || "");
    setCreatorName(d.creatorName ?? "");
    // BABY-half — route campanha in Mode B, user-level perfil on bare URLs.
    const b = c ?? d;
    setBabyName(b.nomeBebe ?? "");
    setRelation(b.relacao ?? "");
    setEventType((b.tipoEvento as PerfilEventTypeSlug | null) ?? "");
    setTeaDate(isoToBR(b.dataEvento));
    setBirthDate(isoToBR(b.dataNascimento));
    setStory(b.historia ?? "");
    // aperture-qjgfr — the DTO carries TWO photo field sets (R5/#236):
    //   fotoXKey = BARE object key   → round-tripped to atualizar as fotoXKey
    //   fotoXUrl = RESOLVED publicUrl → display only (<img src>)
    // fotoKeys.current MUST hold bare keys; storing the resolved URL here is
    // what caused the re-prefix mangling this fix closes.
    fotoKeys.current = {
      perfil: b.fotoPerfilKey,
      capa: b.fotoCapaKey,
      historia: b.fotoHistoriaKey,
    };
    // aperture-7sb1h — carry the wizard-captured gender through saves.
    setGenero(b.genero ?? "");
    setFotoUrls({
      perfil: b.fotoPerfilUrl,
      capa: b.fotoCapaUrl,
      historia: b.fotoHistoriaUrl,
    });
    setTweaks({ babyName: b.nomeBebe ?? "" });
    // aperture-1yx1n — capture the echo + skip baselines (Mode-B save flow).
    perfilEchoRef.current = d;
    creatorNameSaved.current = (d.creatorName ?? "").trim();
    hydrated.current = true;
  }, [perfilQuery.data, perfilCampanhaQuery.data, idCampanha, slug, setTweaks]);

  const atualizar = trpc.perfil.atualizar.useMutation({
    onSuccess: (updated) => {
      // Re-seed from the fresh DTO: bare keys → round-trip ref, resolved urls
      // → display. After the extrairKey strip these are always single-prefixed.
      fotoKeys.current = {
        perfil: updated.fotoPerfilKey,
        capa: updated.fotoCapaKey,
        historia: updated.fotoHistoriaKey,
      };
      setFotoUrls({
        perfil: updated.fotoPerfilUrl,
        capa: updated.fotoCapaUrl,
        historia: updated.fotoHistoriaUrl,
      });
      setTweaks({ babyName: updated.nomeBebe ?? babyName.trim() });
      // aperture-7sb1h — keep the field fresh from the round-trip DTO.
      setGenero(updated.genero ?? "");
      utils.perfil.getPerfil.setData(undefined, updated);
      toast.success("Tudo salvo! Feito com carinho ♡");
    },
    onError: (err) => {
      toast.error(err.message || "não consegui salvar — tenta de novo?");
    },
  });

  const emitirUpload = trpc.perfil.emitirUrlUploadFoto.useMutation();

  // aperture-1yx1n — Mode-B mutations. perfilCampanha.atualizar carries the
  // FORM's baby-half to the ROUTE campanha. The user-level echo save uses a
  // SEPARATE perfil.atualizar handle: the Mode-A `atualizar` above re-seeds
  // photo/genero/tweaks state from the USER-level DTO in onSuccess, which
  // would clobber the route campanha's state on screen.
  const atualizarCampanha = trpc.perfilCampanha.atualizar.useMutation();
  const atualizarUsuarioEco = trpc.perfil.atualizar.useMutation();
  const emitirUploadCampanha =
    trpc.perfilCampanha.emitirUrlUploadFoto.useMutation();

  // Single source of truth for the atualizar payload — shared by the manual
  // save and the photo-upload persist. Dates are parsed defensively (invalid →
  // null) so a half-typed date never blocks persisting a photo.
  const currentPayload = () => ({
    nomeExibicao: creatorName.trim(),
    // aperture-0xoy0 — nomeBebe is nullable; send null (not "") when empty so a
    // photo upload can persist before the baby name is filled (no min(1) reject).
    nomeBebe: babyName.trim() || null,
    relacao: relation.trim() || null,
    historia: story.trim() || null,
    dataNascimento: birthDate.trim() ? brToISO(birthDate) : null,
    tipoEvento: eventType || null,
    // aperture-7sb1h — whole-content replacement: EVERY AtualizarPerfilInput
    // field must round-trip or it resets to its default. If you ADD a field
    // to AtualizarPerfilInputSchema, add it HERE too — an omitted field is a
    // silent wipe, not a no-op.
    genero: genero || null,
    dataEvento: teaDate.trim() ? brToISO(teaDate) : null,
    fotoPerfilKey: fotoKeys.current.perfil,
    fotoCapaKey: fotoKeys.current.capa,
    fotoHistoriaKey: fotoKeys.current.historia,
  });

  // aperture-1yx1n — Mode-B payload: the FORM's baby-half addressed to the
  // ROUTE campanha. Same whole-content-replacement semantics as currentPayload
  // (incl. the aperture-7sb1h genero echo); the contract takes Date|null for
  // the dates where the user-level input takes ISO strings.
  const campanhaPayload = (id: string) => {
    const nascISO = birthDate.trim() ? brToISO(birthDate) : null;
    const eventoISO = teaDate.trim() ? brToISO(teaDate) : null;
    return {
      idCampanha: id,
      nomeBebe: babyName.trim() || null,
      relacao: relation.trim() || null,
      historia: story.trim() || null,
      dataNascimento: nascISO ? new Date(nascISO) : null,
      tipoEvento: eventType || null,
      genero: genero || null,
      dataEvento: eventoISO ? new Date(eventoISO) : null,
      fotoPerfilKey: fotoKeys.current.perfil,
      fotoCapaKey: fotoKeys.current.capa,
      fotoHistoriaKey: fotoKeys.current.historia,
      // aperture — TweaksPanel fields this form doesn't edit. Echoed from
      // TweaksContext (hydrated from the same perfilCampanha.get source) so
      // a PerfilBody save never wipes a TweaksPanel save, matching the
      // whole-content-replacement contract (aperture-7sb1h).
      papais: tweaks.parents.trim() || null,
      corPrimaria: tweaks.primary || null,
      corAcento: tweaks.accent || null,
    };
  };

  // aperture-1yx1n — whole-content save of the FORM's baby-half to the target
  // campanha, then re-seed keys/urls/genero/tweaks from the fresh DTO (mirror
  // of the legacy atualizar onSuccess). Throws on failure so callers can gate
  // what follows. aperture-qmaoi — target is now a param (rota ?? oldest), so
  // bare-URL saves address the default campanha too.
  const salvarCampanha = async (target: string) => {
    const fresh = await atualizarCampanha.mutateAsync(campanhaPayload(target));
    fotoKeys.current = {
      perfil: fresh.fotoPerfilKey,
      capa: fresh.fotoCapaKey,
      historia: fresh.fotoHistoriaKey,
    };
    setFotoUrls({
      perfil: fresh.fotoPerfilUrl,
      capa: fresh.fotoCapaUrl,
      historia: fresh.fotoHistoriaUrl,
    });
    setGenero(fresh.genero ?? "");
    setTweaks({ babyName: fresh.nomeBebe ?? babyName.trim() });
    utils.perfilCampanha.get.setData({ idCampanha: target }, fresh);
    // aperture-qmaoi — when the target is the DEFAULT campanha, the cached
    // perfil.getPerfil DTO (whose shim reads that same campanha) is now stale
    // for its baby-half; invalidate so painel surfaces refetch fresh.
    void utils.perfil.getPerfil.invalidate();
  };

  const saveErrorMessage = (err: unknown) =>
    err instanceof Error && err.message
      ? err.message
      : "não consegui salvar — tenta de novo?";

  // aperture-1yx1n / aperture-qmaoi — campanha-addressed save (now EVERY save
  // with a resolvable campanha: rota ?? oldest). perfilCampanha.atualizar gets
  // the FORM's baby-half; the user-level perfil.atualizar persists ONLY
  // nomeExibicao.
  // aperture-hsxim (W2 shed): the qmaoi ECHO pattern is RETIRED —
  // perfil.atualizar is slim ({nomeExibicao} only) and writes NO baby
  // content anywhere, so the shim-era clobber surface (oldest-campanha
  // overwrite) no longer exists. The response DTO still carries the
  // read-through baby-half from the oldest campanha's perfil_campanhas, so
  // the echo-ref/cache refresh keeps working unchanged. Unchanged
  // creatorName → skip the user-level half entirely (cheaper). Order kept
  // (name first, campanha save last) — no longer load-bearing, just stable.
  const handleSaveCampanha = async (target: string) => {
    if (creatorName.trim() !== creatorNameSaved.current) {
      try {
        const updated = await atualizarUsuarioEco.mutateAsync({
          nomeExibicao: creatorName.trim(),
        });
        // Keep the echo fresh from the round-trip DTO (aperture-7sb1h pattern).
        perfilEchoRef.current = updated;
        creatorNameSaved.current = creatorName.trim();
        utils.perfil.getPerfil.setData(undefined, updated);
      } catch (err) {
        toast.error(saveErrorMessage(err));
        return;
      }
    }
    try {
      await salvarCampanha(target);
    } catch (err) {
      toast.error(saveErrorMessage(err));
      return;
    }
    toast.success("Tudo salvo! Feito com carinho ♡");
  };

  // V4 flow: presign (emitirUrlUploadFoto) → PUT the cropped blob DIRECT to
  // MinIO → persist the returned objectKey via atualizar → preview shows the
  // publicUrl immediately. Throws on failure so PhotoSlot surfaces the error.
  const uploadFoto = async (slot: FotoSlot, blob: Blob, contentType: FotoContentType) => {
    // aperture-qmaoi — presign under the WRITE campanha (rota ?? oldest); the
    // user-level presign survives only for the no-campanha edge. Same presign
    // output either way.
    const { uploadUrl, objectKey, publicUrl } = idCampanhaEscrita
      ? // NOTE: shipped input param is `slot` (not the contract note's `tipo`) —
          // real router shape wins, flagged to Rex on the aphk8 bead.
          await emitirUploadCampanha.mutateAsync({
            idCampanha: idCampanhaEscrita,
            slot,
            contentType,
          })
      : await emitirUpload.mutateAsync({ slot, contentType });
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: blob,
    });
    if (!res.ok) throw new Error(`upload falhou (${res.status})`);
    fotoKeys.current = { ...fotoKeys.current, [slot]: objectKey };
    setFotoUrls((prev) => ({ ...prev, [slot]: publicUrl }));
    if (idCampanhaEscrita) {
      // aperture-qmaoi — persist the key on the WRITE campanha (rota ??
      // oldest). nomeExibicao isn't part of this save, so creatorName doesn't
      // gate it; errors surface as the save toast (parity with the legacy
      // path's onError). No echo needed: salvarCampanha never touches
      // perfil.atualizar.
      try {
        await salvarCampanha(idCampanhaEscrita);
        toast.success("Tudo salvo! Feito com carinho ♡");
      } catch (err) {
        toast.error(saveErrorMessage(err));
      }
      return;
    }
    // aperture-0xoy0 — persist the photo key the moment the bytes land, so they
    // never orphan in the bucket. babyName no longer gates this (nomeBebe is
    // nullable → currentPayload sends null when empty). Only the always-present
    // creatorName (nomeExibicao is required) needs to be set to save.
    // (no-campanha edge only — aperture-qmaoi)
    if (creatorName.trim()) {
      atualizar.mutate(currentPayload());
    } else {
      toast("foto enviada ♡ — preencha o seu nome e salve pra guardar");
    }
  };

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
    // The dataEvento / dataNascimento locals above gate on validity; the payload
    // builders re-parse them (same result) and assemble the full payload incl.
    // photo keys.
    // aperture-qmaoi — every save with a resolvable campanha (rota ?? oldest)
    // is campanha-addressed: baby-half → perfilCampanha.atualizar, nomeExibicao
    // → perfil.atualizar (echo discipline). The legacy full perfil.atualizar
    // survives ONLY for the no-campanha edge — never invent an id
    // (aperture-1kbyx guardrail).
    if (idCampanhaEscrita) {
      void handleSaveCampanha(idCampanhaEscrita);
    } else {
      atualizar.mutate(currentPayload());
    }
  };

  const saving =
    atualizar.isPending || atualizarCampanha.isPending || atualizarUsuarioEco.isPending;

  // Event-type options: the 5 selectable slugs, plus the currently-loaded
  // value if it isn't one of them (so an existing chá-revelação still shows
  // and isn't silently dropped on the next save).
  const eventOptions: PerfilEventTypeSlug[] =
    eventType && !SELECTABLE_EVENT_TYPES.includes(eventType)
      ? [eventType, ...SELECTABLE_EVENT_TYPES]
      : SELECTABLE_EVENT_TYPES;

  // ── Loading / error states (real, replacing the demo snapshot) ──
  // aperture-1yx1n — Mode B waits on BOTH halves (user + route campanha) so
  // the form hydrates once, fully. Bare URLs never enable the campanha query.
  if (perfilQuery.isLoading || (idCampanha && perfilCampanhaQuery.isLoading)) {
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

  if (perfilQuery.error || (idCampanha && perfilCampanhaQuery.error)) {
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
            onClick={() => {
              void perfilQuery.refetch();
              // aperture-1yx1n — Mode B: retry the campanha half too.
              if (idCampanha) void perfilCampanhaQuery.refetch();
            }}
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
        {/* aperture (1-troca) — the editor only renders until the campanha
            has used its ONE allowed slug change via this screen; after
            that, only the "copiar link" block below remains. idCampanhaEscrita
            is the actual write target (mirrors every other save call in
            this component — see currentPayload/campanhaPayload above). */}
        {!slugJaAlterado && idCampanhaEscrita && (
          <SlugEditor
            idCampanha={idCampanhaEscrita}
            currentSlug={campanhaSlugRota ?? ""}
            onChanged={() => {
              // campanhas.list invalidation (inside SlugEditor's onSuccess)
              // already refreshes campanhaSlugRota + slugJaAlterado — no
              // local state or navigation needed here.
            }}
          />
        )}

        <div className="perfil-share">
          <span className="perfil-share-eyebrow">link da página</span>
          <div className="perfil-share-row">
            {/* aperture-2v91z — display + copy both carry the campanha's own
                pretty slug when chosen; /c/<uuid> copy fallback otherwise. */}
            <span
              className="perfil-share-url"
              title={paginaShareUrl(profileSlug, idCampanha, campanhaSlugRota)}
            >
              {paginaShareDisplayPrefix()}
              {paginaShareDisplayPath(profileSlug, campanhaSlugRota)}
            </span>
            <button
              type="button"
              className="perfil-share-copy"
              onClick={() => {
                // aperture-1yx1n — copy the REAL public page URL, campanha-
                // addressed when this perfil sits under a /c/:id route.
                const link = paginaShareUrl(profileSlug, idCampanha, campanhaSlugRota);
                sendEvent("painel_compartilhar_link_click");
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
          <PerfilDateField
            id="perfil-tea"
            value={teaDate}
            onChange={setTeaDate}
            clearLabel="Limpar data do chá"
            calLabel="Abrir calendário — data do chá"
          />
        </Field>

        <Field label="data prevista de nascimento" htmlFor="perfil-birth">
          <PerfilDateField
            id="perfil-birth"
            value={birthDate}
            onChange={setBirthDate}
            clearLabel="Limpar data de nascimento"
            calLabel="Abrir calendário — data de nascimento"
          />
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

        <div className="perfil-field-pair">
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

          <Field label="sexo do bebê" htmlFor="perfil-genero">
            <div className="perfil-select-wrap">
              <select
                id="perfil-genero"
                className="perfil-input perfil-select"
                value={genero}
                onChange={(e) => setGenero(e.target.value as Genero | "")}
              >
                <option value="">selecione</option>
                {GENEROS.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
              <span className="perfil-select-chev">{ico.chev}</span>
            </div>
          </Field>
        </div>
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
          <PhotoSlot slot="perfil" displayUrl={fotoUrls.perfil} onUpload={uploadFoto} />
          <PhotoSlot slot="capa" displayUrl={fotoUrls.capa} onUpload={uploadFoto} />
          <PhotoSlot
            slot="historia"
            displayUrl={fotoUrls.historia}
            onUpload={uploadFoto}
          />
        </div>
      </PerfilSection>

      <div className="perfil-actions">
        <a className="perfil-btn perfil-btn-ghost" href={painelHref(profileSlug, undefined, idCampanha)}>
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
