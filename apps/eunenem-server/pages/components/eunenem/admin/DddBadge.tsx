import type { CSSProperties } from "react";

/**
 * DddBadge — the operator's bounded-context wayfinding tag.
 *
 * Color map per Wheatley's rsidz rescope (2026-06-01):
 *   - Usuario     → blue
 *   - Arrecadacao → green
 *   - Pagamentos  → amber
 *   - Financeiro  → purple
 *
 * These are admin-only colours; they intentionally do NOT pull from the
 * customer scrapbook palette (cream / lilac / plum). The admin surface is
 * the engineering view — typography is clean sans + mono, badges are
 * saturated and labelled, the visual departure from the consumer page is
 * the point. Appears at the top of every admin page so the operator
 * always knows which BC they're reading.
 */

export type Bc = "usuario" | "arrecadacao" | "pagamentos" | "financeiro";

type BcStyle = {
  label: string;
  bg: string;
  text: string;
  dot: string;
  border: string;
};

const STYLES: Record<Bc, BcStyle> = {
  usuario: {
    label: "Usuário",
    bg: "bg-blue-50",
    text: "text-blue-800",
    dot: "bg-blue-500",
    border: "border-blue-200",
  },
  arrecadacao: {
    label: "Arrecadação",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
    border: "border-emerald-200",
  },
  pagamentos: {
    label: "Pagamentos",
    bg: "bg-amber-50",
    text: "text-amber-800",
    dot: "bg-amber-500",
    border: "border-amber-200",
  },
  financeiro: {
    label: "Financeiro",
    bg: "bg-purple-50",
    text: "text-purple-800",
    dot: "bg-purple-500",
    border: "border-purple-200",
  },
};

const SIZE_CLASSES = {
  sm: "px-2 py-[3px] text-[10px] tracking-[0.12em]",
  md: "px-2.5 py-1 text-[11px] tracking-[0.14em]",
} as const;

type Size = keyof typeof SIZE_CLASSES;

type DddBadgeProps = {
  bc: Bc;
  size?: Size;
  /** Show only the colour dot, no text. Useful for dense table rows. */
  iconOnly?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function DddBadge({
  bc,
  size = "md",
  iconOnly = false,
  className,
  style,
}: DddBadgeProps) {
  const s = STYLES[bc];
  const base = `inline-flex items-center gap-1.5 rounded-full border font-mono font-semibold uppercase ${s.bg} ${s.text} ${s.border} ${SIZE_CLASSES[size]}`;
  return (
    <span
      data-bc={bc}
      className={[base, className].filter(Boolean).join(" ")}
      style={style}
      aria-label={`Bounded context: ${s.label}`}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${s.dot}`}
      />
      {iconOnly ? null : <span>{s.label}</span>}
    </span>
  );
}

/**
 * Strap that renders every BC badge in canonical reading order. Useful
 * as a legend on the admin landing page and as a stub above drill pages
 * before they pass a single active BC down.
 */
export function DddBadgeLegend({ className }: { className?: string }) {
  const order: Bc[] = ["usuario", "arrecadacao", "pagamentos", "financeiro"];
  return (
    <div
      className={["flex flex-wrap items-center gap-2", className ?? ""].join(
        " ",
      )}
      role="list"
      aria-label="Bounded contexts"
    >
      {order.map((bc) => (
        <span key={bc} role="listitem">
          <DddBadge bc={bc} size="sm" />
        </span>
      ))}
    </div>
  );
}
