import { useEffect, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import { toast } from "sonner";

// aperture-w4afb (V4) — per-slot photo config. Aspect is LOCKED in the cropper
// so the creator sees exactly the crop that will show. Slot keys match the
// contract's emitirUrlUploadFoto slot enum ('perfil'|'capa'|'historia').
//
// aperture-whxzg — extracted VERBATIM from painel/PerfilBody.tsx so the owner
// inline editor on /pagina/:slug (TweaksPanel) reuses the SAME cropper +
// upload affordance instead of growing a second one. PerfilBody imports it
// back from here. Additions are opt-in (`inline` prop): the "foto salva ao
// enviar" disclosure + inline enviando/salva/erro status the public-page
// editor needs because it has no surrounding form to explain the flow.
export const SLOT_CONFIG = {
  perfil: { label: "Foto de Perfil", cta: "escolher foto para Perfil", aspect: 1 },
  capa: { label: "Foto de Capa", cta: "escolher foto para Capa", aspect: 5 / 4 },
  historia: { label: "Foto de História", cta: "escolher foto para História", aspect: 7 / 8 },
} as const;
export type FotoSlot = keyof typeof SLOT_CONFIG;
// Matches the contract's CONTENT_TYPES_PERMITIDOS. We always export JPEG from
// the cropper, but the type stays a union to match emitirUrlUploadFoto's input.
export type FotoContentType = "image/jpeg" | "image/png" | "image/webp";

type CropArea = { x: number; y: number; width: number; height: number };

/** aperture-whxzg — the disclosure every inline slot shows BEFORE the picker opens. */
// Copy deliberately avoids the word "salvar": accessible names are substring-
// matched by tooling/screen-reader search and must not collide with the
// panel's Salvar button.
export const PHOTO_SAVE_DISCLOSURE = "foto salva na hora do envio";
export const PHOTO_SAVED_LABEL = "foto salva ♡";
export const PHOTO_UPLOADING_LABEL = "enviando a foto…";
export const PHOTO_ERROR_LABEL = "não consegui enviar a foto — tenta de novo?";

const ico = {
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
export function CropperModal({
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
export function PhotoSlot({
  slot,
  displayUrl,
  onUpload,
  dropzoneId,
  inline = false,
  label,
}: {
  slot: FotoSlot;
  displayUrl: string | null;
  onUpload: (slot: FotoSlot, blob: Blob, contentType: FotoContentType) => Promise<void>;
  /** aperture-whxzg — DOM id of the dropzone so openEditor(field) can focus it. */
  dropzoneId?: string;
  /**
   * aperture-whxzg — public-page inline editor mode: shows the
   * "foto salva ao enviar" disclosure BEFORE the picker opens and inline
   * enviando/salva/erro status (the painel form has its own toasts).
   */
  inline?: boolean;
  /** Override the SLOT_CONFIG header label (inline editor uses page wording). */
  label?: string;
}) {
  const cfg = SLOT_CONFIG[slot];
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const shownLabel = label ?? cfg.label;

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
    setSaved(false);
    try {
      await onUpload(slot, blob, "image/jpeg");
      setSaved(true);
    } catch {
      setError(PHOTO_ERROR_LABEL);
    } finally {
      setUploading(false);
    }
  };

  const filled = !!displayUrl;
  const statusId = dropzoneId ? `${dropzoneId}-status` : undefined;

  return (
    <div className="perfil-foto-slot">
      <div className="perfil-foto-header">
        <span className="perfil-foto-icon" aria-hidden="true">
          {ico.photo}
        </span>
        <span className="perfil-foto-label">{shownLabel}</span>
      </div>

      {inline && (
        <span className="perfil-field-hint" data-testid={`${slot}-disclosure`}>
          {PHOTO_SAVE_DISCLOSURE}
        </span>
      )}

      <div
        id={dropzoneId}
        className={`perfil-foto-dropzone${filled ? " perfil-foto-dropzone--filled" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={inline ? `${cfg.cta} (${PHOTO_SAVE_DISCLOSURE})` : cfg.cta}
        aria-describedby={statusId}
        aria-busy={uploading || undefined}
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
            alt={`${shownLabel} — atual`}
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

      {inline && (
        <span
          id={statusId}
          className="perfil-field-hint"
          role="status"
          aria-live="polite"
          style={{
            color: error ? "var(--coral-pink)" : "var(--green-deep)",
            fontWeight: 600,
            minHeight: 16,
          }}
        >
          {uploading ? PHOTO_UPLOADING_LABEL : error ? error : saved ? PHOTO_SAVED_LABEL : ""}
        </span>
      )}
      {!inline && error && (
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
          label={shownLabel}
          onCancel={() => setPendingFile(null)}
          onConfirm={onCropped}
        />
      )}
    </div>
  );
}
