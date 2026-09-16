/**
 * aperture-n1b34 — pure decision logic for the painel tutorial auto-open.
 *
 * Extracted from PainelPage so the remount / reload / Back / not-yet-loaded /
 * dismissed / deep-link matrix is unit-testable without a browser. The page
 * feeds it the live `usuario.tutorialStatus` data (server truth for the
 * CURRENT session's user — another account on the same browser gets its own
 * status from the wire, never a shared local flag), the session dismissal
 * latch, and `window.location.search`.
 */

export const TUTORIAL_DEEP_LINK_PARAM = 'tutorial';
export const TUTORIAL_DEEP_LINK_VALUE = 'open';

export type TutorialStatusLike = { readonly completado: boolean } | null | undefined;

/** `?tutorial=open` — manual replay deep-link from a sub-page. */
export function tutorialDeepLinkRequested(search: string): boolean {
  return new URLSearchParams(search).get(TUTORIAL_DEEP_LINK_PARAM) === TUTORIAL_DEEP_LINK_VALUE;
}

export type TutorialGateInput = {
  /** `usuario.tutorialStatus` data; undefined/null while the query is unsettled. */
  readonly status: TutorialStatusLike;
  /** User already completed/dismissed the overlay in THIS mount. */
  readonly dismissedThisSession: boolean;
  /** `window.location.search` (with or without the leading `?`). */
  readonly search: string;
};

/**
 * Should the overlay auto-open right now?
 *
 *  - dismissed this session → never (the latch outranks the wire, aperture-4my2a)
 *  - explicit `?tutorial=open` → yes (manual replay)
 *  - status unknown (query not settled / errored) → no — we never flash a
 *    transient overlay before the server has told us the user's state
 *  - status.completado → no (reload, Back, remount, different device: all
 *    read the persisted flag)
 *  - otherwise → yes (first eligible visit)
 */
export function shouldAutoOpenTutorial(input: TutorialGateInput): boolean {
  if (input.dismissedThisSession) return false;
  if (tutorialDeepLinkRequested(input.search)) return true;
  if (!input.status) return false;
  return input.status.completado !== true;
}

/**
 * Href with the `?tutorial=open` deep-link removed, or `null` when the URL
 * carried no such param (caller skips `history.replaceState`). Without this,
 * ENCERRAR on a deep-linked visit followed by Back would replay the overlay
 * from the URL alone — the other half of the "reopens on return" report.
 */
export function stripTutorialDeepLink(href: string): string | null {
  const url = new URL(href, 'http://placeholder.invalid');
  if (url.searchParams.get(TUTORIAL_DEEP_LINK_PARAM) !== TUTORIAL_DEEP_LINK_VALUE) return null;
  url.searchParams.delete(TUTORIAL_DEEP_LINK_PARAM);
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
}
