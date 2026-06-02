import { useState } from "react";

/**
 * JsonViewer — collapsed-by-default JSON tree for the admin DDD-trace
 * drill-down (aperture-rsidz.5, W4).
 *
 * Designed for operator inspection of bounded-context snapshots
 * (TransacaoExterna, IntencaoPagamento, ComposicaoValores). Generic over
 * `unknown` so W5 (Financeiro) can reuse it for lançamento JSON if needed.
 *
 * Behavior:
 *   - Root is rendered collapsed: `{...} (N keys)` / `[...] (N items)`.
 *   - Click a collapsed node to expand one level (children also start
 *     collapsed — operator opens deeper levels deliberately).
 *   - Values are typed-colored: string=emerald, number=sky, boolean=amber,
 *     null=italic gray, undefined=italic gray.
 *   - Keys are font-mono.
 *   - A single "copiar JSON" button next to the label copies the full
 *     subsection (pretty-printed) to the clipboard. SSR-safe — guards
 *     `typeof navigator !== "undefined"` the same way W3's IdCopyChip does.
 *
 * Intentionally NO external dependency. ~50 LOC of node-recursion is
 * cheaper than any tree library and we own the visual language.
 */
export default function JsonViewer({
  data,
  label,
}: {
  data: unknown;
  label?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-cream-2/40">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
          {label ?? "json"}
        </p>
        <CopyJsonButton data={data} />
      </div>
      <div className="px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
        <Node value={data} depth={0} startCollapsed={true} />
      </div>
    </div>
  );
}

function Node({
  value,
  depth,
  startCollapsed,
}: {
  value: unknown;
  depth: number;
  startCollapsed: boolean;
}) {
  if (value === null) {
    return <span className="italic text-ink-mute">null</span>;
  }
  if (value === undefined) {
    return <span className="italic text-ink-mute">undefined</span>;
  }
  if (typeof value === "string") {
    return <span className="text-emerald-700">&quot;{value}&quot;</span>;
  }
  if (typeof value === "number") {
    return <span className="text-sky-700 tabular-nums">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-amber-700">{value ? "true" : "false"}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <CollapsibleContainer
        kind="array"
        count={value.length}
        startCollapsed={startCollapsed}
        renderChildren={() => (
          <ul className="ml-3 border-l border-line pl-3">
            {value.map((child, i) => (
              <li key={i} className="py-[2px]">
                <span className="mr-2 text-ink-mute">{i}:</span>
                <Node value={child} depth={depth + 1} startCollapsed={true} />
              </li>
            ))}
          </ul>
        )}
      />
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <CollapsibleContainer
        kind="object"
        count={entries.length}
        startCollapsed={startCollapsed}
        renderChildren={() => (
          <ul className="ml-3 border-l border-line pl-3">
            {entries.map(([k, child]) => (
              <li key={k} className="py-[2px]">
                <span className="mr-2 text-plum">{k}:</span>
                <Node value={child} depth={depth + 1} startCollapsed={true} />
              </li>
            ))}
          </ul>
        )}
      />
    );
  }
  // Fallback — unknown primitive (bigint, symbol, fn). Render as String().
  return <span className="text-ink-soft">{String(value)}</span>;
}

function CollapsibleContainer({
  kind,
  count,
  startCollapsed,
  renderChildren,
}: {
  kind: "object" | "array";
  count: number;
  startCollapsed: boolean;
  renderChildren: () => React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const open = kind === "object" ? "{" : "[";
  const close = kind === "object" ? "}" : "]";
  const noun = kind === "object" ? (count === 1 ? "key" : "keys") : count === 1 ? "item" : "items";

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="inline-flex items-center gap-1.5 rounded px-1 py-[1px] text-ink-soft transition-colors hover:bg-cream-2 hover:text-plum focus:outline-none focus:ring-1 focus:ring-lilac-soft"
        aria-label={`Expandir ${kind === "object" ? "objeto" : "lista"} com ${count} ${noun}`}
      >
        <span>{open}…{close}</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          {count} {noun}
        </span>
      </button>
    );
  }

  return (
    <span>
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="inline-flex items-center rounded px-1 text-ink-soft transition-colors hover:bg-cream-2 hover:text-plum focus:outline-none focus:ring-1 focus:ring-lilac-soft"
        aria-label={`Recolher ${kind === "object" ? "objeto" : "lista"}`}
      >
        {open}
      </button>
      {renderChildren()}
      <span className="text-ink-soft">{close}</span>
    </span>
  );
}

function CopyJsonButton({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const canCopy =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";

  if (!canCopy) return null;

  const onClick = async () => {
    try {
      const json = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No UX surface for clipboard errors in admin v1.
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "copiado" : "Copiar JSON"}
      aria-label={copied ? "JSON copiado" : "Copiar JSON"}
      className="group inline-flex items-center gap-1.5 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft transition-colors hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
    >
      <span
        className={
          copied ? "text-emerald-600" : "text-ink-mute group-hover:text-plum"
        }
      >
        {copied ? "copiado" : "copiar json"}
      </span>
    </button>
  );
}
