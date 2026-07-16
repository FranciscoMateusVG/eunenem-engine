import { painelConvitePreviewHref } from './painelRoutes.js';

export type ConviteShareResult = 'shared' | 'copied' | 'cancelled';
export const CONVITE_SHARE_DEVELOPMENT_ORIGIN = 'http://localhost:3001/';

/** Normalise an origin to exactly one trailing slash (URL() joins expect it). */
function comBarraFinal(origin: string): string {
  return origin.endsWith('/') ? origin : `${origin}/`;
}

// aperture-2v91z — idCampanha threads through so a native share targets THE
// CAMPANHA'S convite; without it every share pointed at the OLDEST
// campanha's preview (real leak — a guest opened the wrong chá's invite).
export function buildConvitePreviewShareUrl(
  origin: string,
  slug: string,
  idCampanha?: string | null,
): string {
  return new URL(painelConvitePreviewHref(slug, idCampanha ?? undefined), origin).toString();
}

/**
 * The origin used for shared convite / página links.
 *
 * aperture-ejghb: this was a hardcoded `https://eunenem.xeroxtoxerox.com/`
 * constant, so every shared invite pointed at a dead domain the moment the app
 * moved hosts — funnel-breaking (dead links = no guests). The canonical origin
 * for a SAME-SITE convite link is simply wherever the app is actually served,
 * which in the browser is `window.location.origin` — automatically correct on
 * ANY domain (test / prod / future), with nothing to hardcode or misconfigure.
 * Every real caller is a browser event handler, so this is the live path.
 *
 * The non-browser fallback (SSR pre-hydration / tests) is env-driven: NODE_ENV
 * dev|test → localhost; otherwise the server-provided `EUNENEM_PUBLIC_ORIGIN`
 * (falling back to localhost rather than any hardcoded host). No dead domain
 * survives anywhere in this function.
 */
export function getDefaultConviteShareOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return comBarraFinal(window.location.origin);
  }

  const nodeEnv = typeof process !== 'undefined' ? process.env.NODE_ENV : undefined;
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return CONVITE_SHARE_DEVELOPMENT_ORIGIN;
  }

  const envOrigin =
    typeof process !== 'undefined' ? process.env.EUNENEM_PUBLIC_ORIGIN : undefined;
  return comBarraFinal(
    envOrigin && envOrigin.length > 0 ? envOrigin : CONVITE_SHARE_DEVELOPMENT_ORIGIN,
  );
}

export interface ShareConvitePreviewOptions {
  origin?: string;
  slug: string;
  /** aperture-2v91z — the campanha whose convite is being shared. */
  idCampanha?: string | null;
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
  idCampanha,
  text = 'Quero te mostrar este convite.',
  title = 'Convite',
}: ShareConvitePreviewOptions): ShareData {
  const url = buildConvitePreviewShareUrl(origin, slug, idCampanha);
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
  const { origin = getDefaultConviteShareOrigin(), slug, idCampanha } = options;
  const url = buildConvitePreviewShareUrl(origin, slug, idCampanha);

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
