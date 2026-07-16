import type { RepasseStatus } from "@/components/eunenem/admin/RepassesStubData";

/**
 * Shared repasse-status vocabulary for the admin surfaces — aperture-voao0
 * (Inter PIX payout, epic aperture-8mivl, spec §4.1/§5.5).
 *
 * The FSM grew from the 2-state `solicitado → aprovado` manual flow to the
 * full 7-state Inter transfer lifecycle:
 *
 *   solicitado → aprovado → transferindo → pago
 *                                ├→ verificando → pago | falhou
 *                                └→ falhou ─(retry)→ transferindo
 *                                       └─(cancel)→ cancelado
 *
 * Both AdminRepassesPage (queue chips + row pills) and AdminRepasseDetailPage
 * (headline pill) previously carried their OWN copy of the status palette.
 * They now import from here so the vocabulary can never drift between the two
 * surfaces. Palette shape mirrors the PagamentosList band/dot/label idiom
 * (border-200 / bg-50 / text-800 / dot-500) so the whole admin stays one
 * visual system.
 *
 * Colour semantics (hues already in the admin vocabulary):
 *   solicitado   amber  — pending the admin's action (the queue)
 *   aprovado     sky    — accepted; the payout job is enqueued
 *   transferindo purple — money is actively in flight at Inter (≈ financeiro plum)
 *   verificando  blue   — outcome ambiguous; reconciling (no new PIX fires here)
 *   pago         emerald— settled; the money landed
 *   falhou       red    — confirmed no money moved; admin may retry or cancel
 *   cancelado    stone  — terminal, muted; funds released back to the saldo
 */

export type ChipPalette = {
  border: string;
  bg: string;
  text: string;
  dot: string;
};

export const REPASSE_STATUS_PALETTE: Record<RepasseStatus, ChipPalette> = {
  solicitado: {
    border: "border-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-800",
    dot: "bg-amber-500",
  },
  aprovado: {
    border: "border-sky-200",
    bg: "bg-sky-50",
    text: "text-sky-800",
    dot: "bg-sky-500",
  },
  transferindo: {
    border: "border-purple-200",
    bg: "bg-purple-50",
    text: "text-purple-800",
    dot: "bg-purple-500",
  },
  verificando: {
    border: "border-blue-200",
    bg: "bg-blue-50",
    text: "text-blue-800",
    dot: "bg-blue-500",
  },
  pago: {
    border: "border-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
  },
  falhou: {
    border: "border-red-200",
    bg: "bg-red-50",
    text: "text-red-800",
    dot: "bg-red-500",
  },
  cancelado: {
    border: "border-stone-300",
    bg: "bg-stone-100",
    text: "text-stone-600",
    dot: "bg-stone-400",
  },
};

/**
 * Canonical display order — the natural FSM progression, terminals last.
 * Drives the queue filter chips so operators read the lifecycle left→right.
 */
export const REPASSE_STATUS_ORDER: readonly RepasseStatus[] = [
  "solicitado",
  "aprovado",
  "transferindo",
  "verificando",
  "pago",
  "falhou",
  "cancelado",
] as const;

/**
 * Short operator-facing gloss under each state. The admin surface shows the
 * raw enum in the pill (operators want the exact state name), but the queue
 * chips + detail explainer use these one-liners for context. This is NOT the
 * end-user extrato copy (that lives in the extrato surface, spec §5.5).
 */
export const REPASSE_STATUS_GLOSS: Record<RepasseStatus, string> = {
  solicitado: "aguardando aprovação",
  aprovado: "na fila de transferência",
  transferindo: "transferência em andamento no Inter",
  verificando: "confirmando o resultado no Inter",
  pago: "transferido com sucesso",
  falhou: "falhou — nenhum valor foi movido",
  cancelado: "cancelado — valores devolvidos ao saldo",
};

/** Terminal states carry no further admin action. */
export function isTerminalRepasse(status: RepasseStatus): boolean {
  return status === "pago" || status === "cancelado";
}

/** Retry re-fires the transfer — allowed ONLY from `falhou` (spec §4.1/§6). */
export function canRetryRepasse(status: RepasseStatus): boolean {
  return status === "falhou";
}

/**
 * Cancel is the only claim-release path — allowed ONLY from `falhou`, and it
 * is irreversible (releases the claimed lançamentos back to the saldo, spec
 * §4.1). Same gate as retry: both live on the `falhou` state.
 */
export function canCancelRepasse(status: RepasseStatus): boolean {
  return status === "falhou";
}

/**
 * Manual-resolution pill (spec §5.4 amended) — rendered NEXT TO the
 * `verificando` status pill when reconciliation parked the repasse awaiting
 * an operator (Inter can't echo our referencia; search-fallback candidates
 * need a human match). Rose — deliberately outside the status hue set so a
 * flagged row reads as "needs a person" at a glance, distinct from the blue
 * "system is still working" verificando.
 */
export function ManualResolutionPill({
  size = "sm",
}: {
  size?: "sm" | "md";
}) {
  const sizing =
    size === "md"
      ? "px-2.5 py-[4px] text-[11px]"
      : "px-2 py-[3px] text-[10px]";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 font-mono uppercase tracking-[0.12em] text-rose-800",
        sizing,
      ].join(" ")}
    >
      <span
        aria-hidden
        className="inline-block size-[6px] rounded-full bg-rose-500"
      />
      ação manual
    </span>
  );
}

/**
 * Status pill — the single source of truth for how a repasse status renders
 * across the admin surfaces. `size="sm"` is the row/inline size; `size="md"`
 * is the headline size on the detail page.
 */
export function RepasseStatusPill({
  status,
  size = "sm",
}: {
  status: RepasseStatus;
  size?: "sm" | "md";
}) {
  const palette = REPASSE_STATUS_PALETTE[status];
  const sizing =
    size === "md"
      ? "px-2.5 py-[4px] text-[11px]"
      : "px-2 py-[3px] text-[10px]";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border font-mono uppercase tracking-[0.12em]",
        sizing,
        palette.border,
        palette.bg,
        palette.text,
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${palette.dot}`}
      />
      {status}
    </span>
  );
}
