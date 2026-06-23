import { toBlob } from "html-to-image";

export type ConviteDownloadFormat = "story";

const DOWNLOAD_DIMS: Record<ConviteDownloadFormat, { width: number; height: number }> = {
  story: { width: 400, height: 600 },
};

function slugifyFilenamePart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildConviteDownloadFilename(displayName?: string | null): string {
  const trimmed = (displayName ?? "").trim();
  const safeName = trimmed ? slugifyFilenamePart(trimmed) : "";
  return safeName ? `convite-${safeName}.png` : "convite.png";
}

async function waitForNodeAssets(node: HTMLElement): Promise<void> {
  if (typeof document !== "undefined" && "fonts" in document) {
    await document.fonts.ready;
  }

  const images = Array.from(node.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (image.complete) {
        if ("decode" in image) {
          await image.decode().catch(() => undefined);
        }
        return;
      }

      await new Promise<void>((resolve) => {
        const done = () => {
          image.removeEventListener("load", done);
          image.removeEventListener("error", done);
          resolve();
        };
        image.addEventListener("load", done, { once: true });
        image.addEventListener("error", done, { once: true });
      });
    }),
  );
}

export interface DownloadConvitePngOptions {
  displayName?: string | null;
  format?: ConviteDownloadFormat;
  node: HTMLElement | null;
}

export async function downloadConvitePng({
  displayName,
  format = "story",
  node,
}: DownloadConvitePngOptions): Promise<void> {
  if (!node) {
    throw new Error("A previa do convite nao esta pronta para download.");
  }

  await waitForNodeAssets(node);

  const dims = DOWNLOAD_DIMS[format];
  const blob = await toBlob(node, {
    cacheBust: true,
    canvasWidth: dims.width,
    canvasHeight: dims.height,
    pixelRatio: 2,
  });

  if (!blob) {
    throw new Error("Nao consegui gerar a imagem do convite.");
  }

  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = buildConviteDownloadFilename(displayName);
  anchor.click();
  URL.revokeObjectURL(href);
}
