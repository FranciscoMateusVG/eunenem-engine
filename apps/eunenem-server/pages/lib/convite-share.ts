import { painelConvitePreviewHref } from './painelRoutes.js';

export type ConviteShareResult = 'shared' | 'copied' | 'cancelled';
export const CONVITE_SHARE_PRODUCTION_ORIGIN = 'https://eunenem.xeroxtoxerox.com/';
export const CONVITE_SHARE_DEVELOPMENT_ORIGIN = 'http://localhost:3001/';


export function buildConvitePreviewShareUrl(origin: string, slug: string): string {
  return new URL(painelConvitePreviewHref(slug), origin).toString();
}

export function getDefaultConviteShareOrigin(): string {
  const nodeEnv = typeof process !== 'undefined' ? process.env.NODE_ENV : undefined;

  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return CONVITE_SHARE_DEVELOPMENT_ORIGIN;
  }

  return CONVITE_SHARE_PRODUCTION_ORIGIN;
}

export interface ShareConvitePreviewOptions {
  origin?: string;
  slug: string;
  text?: string;
  title?: string;
}

/**
 * The minimal payload we ever ask the platform to share. It is a plain
 * `{ title, text, url }` — no `files`, no `Blob`, no canvas — which is the only
 * shape Safari reliably accepts. Safari is famously picky about
 * `canShare({ files })`, so we deliberately never put files on this payload.
 */
function buildConviteShareData({
  origin = getDefaultConviteShareOrigin(),
  slug,
  text = 'Quero te mostrar este convite.',
  title = 'Convite',
}: ShareConvitePreviewOptions): ShareData {
  const url = buildConvitePreviewShareUrl(origin, slug);
  return { title, text, url };
}

/**
 * Feature-detects native Web Share support for our payload shape.
 *
 * - Checks `navigator.share` exists at all (Chrome desktop / Firefox lack it).
 * - When `navigator.canShare` exists (Safari, modern Chrome), it is consulted
 *   with the EXACT payload we intend to share. Safari will reject a payload it
 *   cannot handle here rather than throwing later inside `share()`.
 *
 * This is a pure predicate — it touches no async work and consumes no transient
 * activation, so it is safe to call synchronously inside a click handler before
 * deciding which branch to take.
 */
export function canShareConvitePreview(options: ShareConvitePreviewOptions): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false;
  }

  const shareData = buildConviteShareData(options);

  // `canShare` is optional on the spec — when absent, the presence of `share`
  // is the best signal we have, so we treat it as shareable.
  if (typeof navigator.canShare === 'function') {
    try {
      return navigator.canShare(shareData);
    } catch {
      return false;
    }
  }

  return true;
}

async function copyConviteLink(options: ShareConvitePreviewOptions): Promise<ConviteShareResult> {
  const { origin = getDefaultConviteShareOrigin(), slug } = options;
  const url = buildConvitePreviewShareUrl(origin, slug);

  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(url);
    return 'copied';
  }

  throw new Error('Seu navegador nao suporta compartilhamento nativo nem copia de link.');
}

/**
 * Uses the current preview route as the shared destination. This is tied to the
 * temporary preview/bypass flow and will need revisiting when that rollback lands.
 *
 * SAFARI ACTIVATION CONTRACT
 * --------------------------
 * Safari only allows `navigator.share()` while the user gesture's *transient
 * activation* is still alive. Activation is consumed by the first `await` (or
 * any task hop) after the gesture. This helper is therefore written so that
 * `navigator.share()` is the FIRST awaitable it touches — the share payload is
 * built synchronously, with no fetch / canvas / `toBlob` / tRPC call in front
 * of it. As long as the helper itself is the first awaited call inside the
 * click handler, the activation survives.
 *
 * IMPORTANT: this guarantee only holds end-to-end if the *caller* also avoids
 * awaiting anything (e.g. a "save" mutation) before invoking this helper inside
 * the same gesture. See the module note on `shareConvitePreview` callers.
 */
export async function shareConvitePreview(
  options: ShareConvitePreviewOptions,
): Promise<ConviteShareResult> {
  // Built synchronously — no async work precedes the share() call below, so the
  // transient activation handed to this function is still alive when share runs.
  const shareData = buildConviteShareData(options);

  if (canShareConvitePreview(options)) {
    try {
      await navigator.share(shareData);
      return 'shared';
    } catch (error) {
      // AbortError == the user dismissed the native sheet. That is a normal,
      // expected outcome, not a failure: report it as cancelled and do NOT
      // fall through to copying the link behind their back.
      if (error instanceof DOMException && error.name === 'AbortError') {
        return 'cancelled';
      }

      // NotAllowedError == Safari refused the share (typically because the
      // gesture's transient activation was already consumed by an upstream
      // await, or the payload was rejected). This is a real failure. Fall back
      // to copying the link so the user is never left stranded.
      return copyConviteLink(options);
    }
  }

  // No native share available (e.g. Chrome/Firefox desktop): fall back to copy.
  return copyConviteLink(options);
}
