// aperture-j4zjw — convite custom-photo background upload.
//
// The "usar uma foto sua" background used to be a base64 dataUrl held only in
// client state (state.bgUpload), so it never persisted: it wasn't sent on save
// and ImagemUrlConviteSchema requires a real http(s) URL ending in .png/.jpg.
//
// This hook mirrors the gift-item image flow (ItemImageUpload.tsx → the
// presigned PUT to MinIO Rex shipped in #254): re-encode the chosen file to a
// downscaled JPEG, ask the item emitter for a presigned URL, PUT the bytes, and
// return the resulting public URL. The caller stores that URL in state.bgUpload,
// which now round-trips through eventoConvite.save as the convite's imagemUrl.
import { useState } from 'react';

import { useCampanhaRota } from './campanha-rota.js';
import { trpc } from './trpc.js';

// Cap the longest edge so the stored object (and its public URL) stay small;
// the convite preview never needs more than this.
const MAX_DIM = 1600;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error('falha ao carregar imagem')));
    img.src = src;
  });
}

// Re-encode any input image (incl. webp/png) to a downscaled JPEG blob so the
// public URL ends in .jpg (ImagemUrlConviteSchema rejects other extensions) and
// the upload payload is bounded.
async function fileToJpegBlob(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = Math.min(1, MAX_DIM / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas indisponível');
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('falha ao processar a imagem'))),
        'image/jpeg',
        0.9,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Upload a convite background photo and resolve to its persisted public URL.
 * `uploading` drives button/affordance state in the fundo step.
 */
export function useConviteBackgroundUpload() {
  const emitir = trpc.contribuicao.emitirUrlUploadImagemItem.useMutation();
  // aperture-1yx1n — presign under the ROUTE campanha (bare → server default).
  const idCampanha = useCampanhaRota();
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<string> => {
    setUploading(true);
    try {
      const blob = await fileToJpegBlob(file);
      const { uploadUrl, publicUrl } = await emitir.mutateAsync(
        idCampanha
          ? { contentType: 'image/jpeg', idCampanha }
          : { contentType: 'image/jpeg' },
      );
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      if (!res.ok) throw new Error(`upload falhou (${res.status})`);
      return publicUrl;
    } finally {
      setUploading(false);
    }
  };

  return { upload, uploading };
}
