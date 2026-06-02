import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc.js";
import { WebhookEventDetailModal } from "@/components/eunenem/admin/WebhookEventDetailModal";

/**
 * PagamentoWebhookList — expandable per-pagamento webhook trail
 * (aperture-pf348).
 *
 * Renders below each PagamentoCard inside PagamentosSection. Collapsed by
 * default; the affordance chip in the toggle header shows the event count
 * + a red dot when any event has `signatureValid=false` OR
 * `processingError != null`. Click expands the list of events; click an
 * event's "Ver payload" → lazy-fetches the full DTO + mounts a modal
 * with JsonViewer over the raw payload.
 *
 * Visual treatment:
 * - No new BC badge — webhooks are infrastructure detail of Pagamentos,
 *   not a BC peer. The subsection inherits the amber `data-bc="pagamentos"`
 *   parent visually.
 * - Hairline `border-line` + subtle `bg-zinc-50` background so the
 *   subsection reads as "diagnostics shelf" without competing with the
 *   pagamento card chrome.
 * - Per-row badges mirror W4's palette: emerald=verified/processed,
 *   red=invalid/erro, zinc=neutral.
 *
 * Issue-count reporting: every render pings the parent (PagamentosList)
 * via `onIssueCountChange` so the PagamentosSection header can show the
 * aggregate "⚠ N webhooks com erro" chip without a server-side aggregate
 * call. Computed as: count of events where `signatureValid=false` OR
 * `processingError != null`.
 */
export function PagamentoWebhookList({
  idPagamento,
  onIssueCountChange,
}: {
  idPagamento: string;
  onIssueCountChange?: (count: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [modalEventId, setModalEventId] = useState<string | null>(null);

  const { data, isLoading, error } =
    trpc.admin.webhooks.listByPagamento.useQuery({ idPagamento });

  const events = data?.events ?? [];
  const issueCount = events.filter(
    (e) => !e.signatureValid || e.processingError !== null,
  ).length;

  // Report up to parent so PagamentosSection can render the aggregate chip.
  useEffect(() => {
    onIssueCountChange?.(issueCount);
  }, [issueCount, onIssueCountChange]);

  if (isLoading) {
    return (
      <div className="rounded-md border border-line bg-zinc-50 px-4 py-3">
        <div className="h-3 w-40 animate-pulse rounded bg-cream-2" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-red-800">
          eventos webhook · erro
        </p>
        <p className="mt-1 text-[13px] text-red-900">{error.message}</p>
      </div>
    );
  }

  const hasIssues = issueCount > 0;

  return (
    <>
      <div className="overflow-hidden rounded-md border border-line bg-zinc-50">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-100"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-700">
              Eventos webhook
            </span>
            <CountChip count={events.length} hasIssues={hasIssues} />
          </span>
          <span
            aria-hidden
            className="font-mono text-[12px] leading-none text-zinc-500"
          >
            {expanded ? "▲" : "▼"}
          </span>
        </button>

        {expanded && (
          <div className="border-t border-line bg-paper">
            {events.length === 0 ? (
              <div className="px-4 py-4">
                <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
                  Sem eventos webhook
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {events.map((e) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    onOpenPayload={() => setModalEventId(e.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {modalEventId !== null && (
        <WebhookEventDetailModal
          idEvent={modalEventId}
          onClose={() => setModalEventId(null)}
        />
      )}
    </>
  );
}

/* -----------------------------------------------------------------------
 * CountChip — N events badge + red dot signal
 * --------------------------------------------------------------------- */

function CountChip({ count, hasIssues }: { count: number; hasIssues: boolean }) {
  return (
    <span className="relative inline-flex items-center justify-center rounded-full border border-line bg-paper px-1.5 py-[1px] font-mono text-[10px] tabular-nums text-ink-soft">
      {count}
      {hasIssues && (
        <span
          aria-hidden
          title="Algum evento com falha de assinatura ou erro de processamento"
          className="absolute -right-0.5 -top-0.5 inline-block size-1.5 rounded-full bg-red-500 ring-[1.5px] ring-zinc-50"
        />
      )}
    </span>
  );
}

/* -----------------------------------------------------------------------
 * Row — one event
 * --------------------------------------------------------------------- */

type EventListDTO = {
  id: string;
  provider: string;
  eventType: string;
  receivedAt: string;
  signatureValid: boolean;
  processedAt: string | null;
  processingError: string | null;
  pagamentoId: string | null;
};

function EventRow({
  event,
  onOpenPayload,
}: {
  event: EventListDTO;
  onOpenPayload: () => void;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
      <span aria-hidden className="font-mono text-[11px] text-ink-mute">
        ▸
      </span>

      {event.provider !== "stripe" && (
        <span className="rounded border border-line bg-paper px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft">
          {event.provider}
        </span>
      )}

      <span className="font-mono text-[12px] text-ink">{event.eventType}</span>

      <span className="font-mono text-[11px] tabular-nums text-ink-soft">
        {formatReceivedAt(event.receivedAt)}
      </span>

      <SignatureBadge valid={event.signatureValid} />

      <ProcessStatus
        processedAt={event.processedAt}
        processingError={event.processingError}
      />

      <button
        type="button"
        onClick={onOpenPayload}
        className="ml-auto font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-plum"
      >
        Ver payload
      </button>
    </li>
  );
}

function SignatureBadge({ valid }: { valid: boolean }) {
  if (valid) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.10em] text-emerald-800">
        <span aria-hidden>✓</span>
        verificada
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.10em] text-red-800">
      <span aria-hidden>⚠</span>
      inválida
    </span>
  );
}

function ProcessStatus({
  processedAt,
  processingError,
}: {
  processedAt: string | null;
  processingError: string | null;
}) {
  if (processingError !== null) {
    return (
      <span
        className="inline-flex items-baseline gap-1 truncate text-[11.5px] text-red-700"
        title={processingError}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.10em]">
          erro:
        </span>
        <span className="truncate font-mono">{truncate(processingError, 50)}</span>
      </span>
    );
  }
  if (processedAt !== null) {
    return (
      <span className="inline-flex items-baseline gap-1 font-mono text-[11px] tabular-nums text-emerald-700">
        Processado em {formatReceivedAt(processedAt).split(" ")[1] ?? ""}
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] italic text-ink-mute">
      Não processado
    </span>
  );
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatReceivedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${day}/${m} ${hh}:${mm}`;
  }
}
