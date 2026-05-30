// aperture-8qg1s — shared mock for the convidados preview modals
// (VER LINK + VER CONVITE). The convidados surface doesn't carry a
// public-facing event-data context yet; this fills the gap until the
// real source is wired. aperture-ch1kr reuses the same export.

export interface PreviewEvent {
  hostSlug: string;       // e.g. "maria-bebe-2026"
  hostName: string;       // e.g. "maria"
  eventName: string;      // e.g. "chá da maria"
  eventNameHighlight: string; // the substring to wrap in <span class="hl"> — e.g. "chá"
  greeting: string;       // e.g. "olá ♡"
  dateLabel: string;      // e.g. "sábado, 14 de junho"
  timeLabel: string;      // e.g. "16h às 19h" — used by aperture-ch1kr's VER CONVITE preview card
  locationLabel: string;  // e.g. "laranjeiras / rj"
  shareDomain: string;    // e.g. "festa.app/r/"  — produces full URL = shareDomain + hostSlug
}

export const PREVIEW_EVENT: PreviewEvent = {
  hostSlug: "maria-bebe-2026",
  hostName: "maria",
  eventName: "chá da maria",
  eventNameHighlight: "chá",
  greeting: "olá ♡",
  dateLabel: "sábado, 14 de junho",
  timeLabel: "16h às 19h",
  locationLabel: "laranjeiras / rj",
  shareDomain: "festa.app/r/",
};
