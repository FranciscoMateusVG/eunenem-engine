// aperture-tua9o — image upload + crop for a custom ("personalizado") gift item.
//
// Mirrors the profile-photo flow in PerfilBody.tsx (react-easy-crop → cropped
// JPEG blob → presigned PUT to MinIO → persist the returned publicUrl), but
// uses the ITEM emitter Rex shipped in #254:
//   contribuicao.emitirUrlUploadImagemItem({ contentType }) →
//     { uploadUrl, objectKey, publicUrl }   (key: itens/<idUsuario>/<uuid>.<ext>)
// We send the full publicUrl as the item's imagemUrl on create (contribuição
// stores the string as-is — no key→url resolution on read, per the contract).
//
// The crop helpers are intentionally a small local copy of PerfilBody's
// (loadImage/cropToBlob/CropperModal) rather than a shared import, to avoid
// refactoring the large, working V4 PerfilBody. A future DRY follow-up could
// lift these into a shared module.
import { useEffect, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import { toast } from "sonner";

import { trpc } from "@/lib/trpc";

type CropArea = { x: number; y: number; width: number; height: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", () => reject(new Error("falha ao carregar imagem")));
    img.src = src;
  });
}

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

// Square (1:1) crop — matches how catalog/item thumbs render in the lista grid
// and on the guest gift card.
const ITEM_ASPECT = 1;

function CropperModal({
  file,
  onCancel,
  onConfirm,
}: {
  file: File;
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
      role="dialog"
      aria-modal="true"
      aria-label="Recortar imagem do presente"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,26,26,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 90,
        padding: 16,
      }}
    >
      <div
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
          recortar imagem do presente
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
              aspect={ITEM_ASPECT}
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
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={working}
          >
            cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={confirm}
            disabled={working || !area}
          >
            {working ? "recortando…" : "usar imagem"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Optional image control for the custom-item form. `value` is the persisted
 * publicUrl (or null); `onChange` receives the new publicUrl after a successful
 * upload, or null when removed. No image is a valid state (the item just shows
 * its emoji fallback like before).
 */
export function ItemImageUpload({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const emitir = trpc.contribuicao.emitirUrlUploadImagemItem.useMutation();

  const onCropped = async (blob: Blob) => {
    setPendingFile(null);
    setUploading(true);
    try {
      // cropToBlob always emits JPEG → content-type must match the presign.
      const { uploadUrl, publicUrl } = await emitir.mutateAsync({
        contentType: "image/jpeg",
      });
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!res.ok) throw new Error(`upload falhou (${res.status})`);
      onChange(publicUrl);
    } catch {
      toast.error("não consegui enviar a imagem — tenta de novo?");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="lista-field lista-field-full">
      <label>imagem do presente (opcional)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {value ? (
          <span
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              overflow: "hidden",
              flex: "0 0 56px",
              background: "var(--cream-2)",
            }}
          >
            <img
              src={value}
              alt="prévia da imagem do presente"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </span>
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              flex: "0 0 56px",
              background: "var(--cream-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--lilac-deep)",
              fontSize: 22,
            }}
          >
            🎁
          </span>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "enviando…" : value ? "trocar imagem" : "adicionar imagem"}
          </button>
          {value && !uploading && (
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                background: "none",
                border: "none",
                color: "var(--lilac-deep)",
                fontWeight: 600,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              remover
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          if (file) setPendingFile(file);
          e.target.value = "";
        }}
      />
      {pendingFile && (
        <CropperModal
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onConfirm={onCropped}
        />
      )}
    </div>
  );
}
