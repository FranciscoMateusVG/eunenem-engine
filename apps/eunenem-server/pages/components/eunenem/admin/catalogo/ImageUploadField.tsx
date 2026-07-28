import { useRef, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc.js";
import {
  FieldLabel,
  GhostButton,
  MAX_CATALOGO_IMAGEM_SIZE_BYTES,
  TextField,
} from "./catalogo-shared.js";

/**
 * ImageUploadField — presigned-PUT image upload for catalog products
 * (F1, aperture-ytct2), wired to admin.catalog.emitirUrlUploadImagemProduto
 * (verified @ PR #38 / 64ab5006).
 *
 * Contract (layer-4 verified):
 *   - input { contentType: image/jpeg|png|webp, sizeBytes: int 1..5_242_880 }
 *   - PUT the EXACT blob with EXACTLY the declared Content-Type. The browser
 *     derives Content-Length from the Blob — do NOT set it manually. The
 *     presigned URL binds both MIME + length and expires in 300s.
 *   - server returns { uploadUrl, objectKey, publicUrl }; persist publicUrl.
 *
 * The field also accepts a pasted URL (root-relative catalog path or an
 * object-storage URL). We do baseline length validation client-side and let
 * the server be the single authority on the catalog-owned-origin policy
 * (surfacing its BAD_REQUEST) rather than mirroring it here.
 */

const ACCEPTED = ["image/jpeg", "image/png", "image/webp"] as const;
type AcceptedType = (typeof ACCEPTED)[number];

function isAccepted(t: string): t is AcceptedType {
  return (ACCEPTED as readonly string[]).includes(t);
}

export function ImageUploadField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emitir =
    trpc.admin.catalog.emitirUrlUploadImagemProduto.useMutation();

  async function onFilePicked(file: File) {
    if (!isAccepted(file.type)) {
      toast.error("formato inválido — use JPEG, PNG ou WebP.");
      return;
    }
    if (file.size < 1 || file.size > MAX_CATALOGO_IMAGEM_SIZE_BYTES) {
      toast.error("imagem muito grande — máximo 5 MB.");
      return;
    }
    setUploading(true);
    try {
      const { uploadUrl, publicUrl } = await emitir.mutateAsync({
        contentType: file.type,
        sizeBytes: file.size,
      });
      // Content-Type ONLY — the browser sets Content-Length from the Blob.
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`upload falhou (${res.status})`);
      onChange(publicUrl);
      toast.success("imagem enviada.");
    } catch {
      toast.error("não consegui enviar a imagem — tenta de novo?");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div>
      <FieldLabel>Imagem</FieldLabel>
      <div className="flex items-start gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-cream-2/40">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="pré-visualização"
              className="size-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
              sem img
            </span>
          )}
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED.join(",")}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFilePicked(file);
              }}
            />
            <GhostButton
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "enviando…" : "enviar arquivo"}
            </GhostButton>
            {value && (
              <GhostButton onClick={() => onChange(null)} disabled={uploading} danger>
                remover
              </GhostButton>
            )}
          </div>
          <div className="flex items-center gap-2">
            <TextField
              value={pasteUrl}
              onChange={setPasteUrl}
              placeholder="ou cole uma URL (/products/…) e aplique"
              maxLength={2048}
            />
            <GhostButton
              onClick={() => {
                const next = pasteUrl.trim();
                if (!next) return;
                onChange(next);
                setPasteUrl("");
              }}
              disabled={uploading || pasteUrl.trim().length === 0}
            >
              aplicar
            </GhostButton>
          </div>
          <p className="font-mono text-[10px] tracking-[0.04em] text-ink-mute">
            JPEG · PNG · WebP — máx 5 MB.
          </p>
        </div>
      </div>
    </div>
  );
}
