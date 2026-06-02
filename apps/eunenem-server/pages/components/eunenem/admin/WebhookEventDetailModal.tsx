import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc.js";
import JsonViewer from "@/components/eunenem/admin/JsonViewer";

/**
 * WebhookEventDetailModal — "Ver payload" overlay (aperture-pf348).
 *
 * Lazy-fetches `admin.webhooks.getEventDetail` when mounted; renders a
 * full-screen overlay with the event header + signatureHeader (click to
 * copy) + JsonViewer over the rawPayload. Closes via the ✕ button, the
 * backdrop click, or the Escape key. On close the parent unmounts the
 * modal, which unmounts JsonViewer — the heavy rawPayload doesn't stay
 * resident across long admin sessions.
 *
 * Why a modal vs inline expand:
 *   - The full Stripe payload is fat (~2-4 KB JSON each). Inlining N
 *     payloads at once tanks scroll performance + screen real estate.
 *   - One-at-a-time inspection matches the operator's mental flow ("show
 *     me THIS event's payload"); modal makes the focused mode explicit.
 *   - Lazy-fetch keeps the list query (listByPagamento) lean — only the
 *     events operator actually clicks transfer their rawPayload.
 *
 * v1 has no deep-link / router state — modal is in-page only. If operator
 * wants shareable "look at this specific event" URLs, that's a follow-up.
 */
export function WebhookEventDetailModal({
  idEvent,
  onClose,
}: {
  idEvent: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } =
    trpc.admin.webhooks.getEventDetail.useQuery({ idEvent });

  // Escape-to-close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Detalhes do evento webhook"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px]"
        tabIndex={-1}
      />

      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-lg">
        <Header event={data?.event ?? null} onClose={onClose} />

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading && (
            <div className="space-y-2">
              <div className="h-3 w-48 animate-pulse rounded bg-cream-2" />
              <div className="h-3 w-72 animate-pulse rounded bg-cream-2" />
              <div className="h-3 w-32 animate-pulse rounded bg-cream-2" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-800">
                erro
              </p>
              <p className="mt-1 text-[13px] text-red-900">{error.message}</p>
            </div>
          )}

          {data && (
            <div className="space-y-4">
              <SignatureHeaderBlock signatureHeader={data.event.signatureHeader} />
              <JsonViewer label="rawPayload" data={data.event.rawPayload} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Header — event identity + close
 * --------------------------------------------------------------------- */

type DetailEvent = {
  id: string;
  provider: string;
  eventType: string;
  receivedAt: string;
};

function Header({
  event,
  onClose,
}: {
  event: DetailEvent | null;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line bg-cream-2/40 px-5 py-3">
      <div className="min-w-0 space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          evento webhook
        </p>
        {event ? (
          <p className="truncate font-mono text-[13px] text-ink">
            <span className="text-ink-mute">{event.provider}</span>
            <span className="mx-1.5 text-ink-mute">·</span>
            <span>{event.eventType}</span>
            <span className="mx-1.5 text-ink-mute">·</span>
            <span className="tabular-nums">{formatLong(event.receivedAt)}</span>
          </p>
        ) : (
          <p className="font-mono text-[13px] text-ink-soft">carregando…</p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fechar modal"
        className="-mr-2 -mt-1 rounded-md px-2 py-1 font-mono text-[16px] leading-none text-ink-soft transition-colors hover:bg-paper hover:text-plum"
      >
        ✕
      </button>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Signature header — click to copy
 * --------------------------------------------------------------------- */

function SignatureHeaderBlock({
  signatureHeader,
}: {
  signatureHeader: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(signatureHeader).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-soft">
          signatureHeader
        </p>
        <button
          type="button"
          onClick={onCopy}
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-plum"
        >
          {copied ? "copiado ✓" : "copiar"}
        </button>
      </div>
      <p className="break-all rounded-md border border-line bg-cream-2/40 px-3 py-2 font-mono text-[11px] text-ink-soft">
        {signatureHeader}
      </p>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function formatLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}
