import {
  MIGRADO_STATUS,
  type MigradoRow,
  type MigradoStatus,
  type MigradosListResult,
} from "./migrados-contract";

/**
 * MigradosTable — admin "usuários migrados" list (aperture-925nx).
 *
 * Pure renderer in the UsersTable mould: the state machine (debounced search,
 * cursor stack, limit) lives on AdminMigradosPage; this component takes the
 * resolved query state + callbacks. Same visual states as UsersTable:
 *   loading → skeleton rows · error → banner + retry · empty → italic note ·
 *   populated → rows + footer (prev/next, page-size, counter).
 *
 * Truthfulness rules (operator: "don't invent meaning"):
 *   - status pill + gloss come verbatim from MIGRADO_STATUS (server enum);
 *   - the /admin/usuario/:idConta link renders ONLY when idConta is present;
 *   - evidencedAt renders only when the server sent one; otherwise "—";
 *   - counts chips are the server's numbers, no client arithmetic;
 *   - no bulk / migrate / import / edit actions of any kind.
 *
 * Tokens (Visual Identity §2): bg-paper · bg-cream-2/40 · border-line ·
 * text-ink/-soft/-mute · plum · font-mono for ids/labels/counters.
 */

export const LIMIT_OPTIONS = [25, 50, 100] as const;

export type MigradosTableProps = {
  data: MigradosListResult | undefined;
  isFetching: boolean;
  error: { message: string } | null;
  limit: number;
  onLimitChange: (next: number) => void;
  hasPrev: boolean;
  onPrev: () => void;
  hasNext: boolean;
  onNext: () => void;
  /** 1-based index of the first row on this page (owner computes from the cursor stack). */
  startIndex: number;
  onRetry: () => void;
};

export function MigradosTable(props: MigradosTableProps) {
  const { data, isFetching, error } = props;

  if (!data && !error && isFetching) {
    return (
      <div className="overflow-hidden rounded-md border border-line bg-paper">
        <TableHeaderRow disabled />
        <SkeletonRows count={props.limit > 10 ? 10 : props.limit} />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner message={error.message} onRetry={props.onRetry} />;
  }

  const rows = data?.items ?? [];
  const totalCount = data?.totalCount ?? 0;

  if (totalCount === 0) {
    return (
      <div className="overflow-hidden rounded-md border border-line bg-paper">
        <TableHeaderRow disabled />
        <EmptyState />
        <FooterShell {...props} totalCount={0} rowCount={0} />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-line bg-paper">
      <div className="relative">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-line text-[13px] text-ink">
            <TableHeaderRow />
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <TableRow key={row.email} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        {isFetching && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-paper/55 transition-opacity"
          />
        )}
      </div>
      <FooterShell {...props} totalCount={totalCount} rowCount={rows.length} />
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Status chips (counts) — server numbers, labelled with the server semantics
 * --------------------------------------------------------------------- */

export function MigradosCounts({
  counts,
}: {
  counts: MigradosListResult["counts"] | undefined;
}) {
  const entries = (Object.keys(MIGRADO_STATUS) as MigradoStatus[]).map((status) => ({
    status,
    value: counts?.[status],
  }));
  return (
    <dl
      className="flex flex-wrap gap-2"
      aria-label="Contagens por status (do servidor)"
    >
      {entries.map(({ status, value }) => {
        const meta = MIGRADO_STATUS[status];
        return (
          <div
            key={status}
            className="flex items-center gap-2 rounded-md border border-line bg-cream-2/40 px-3 py-1.5"
            title={meta.gloss}
          >
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
              {meta.label}
            </dt>
            <dd className="font-mono text-[13px] tabular-nums text-ink">
              {typeof value === "number" ? value : "—"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/* -----------------------------------------------------------------------
 * Header
 * --------------------------------------------------------------------- */

function TableHeaderRow({ disabled = false }: { disabled?: boolean }) {
  const cls = `px-4 py-2 text-left font-mono text-[10.5px] uppercase tracking-[0.14em] ${
    disabled ? "text-ink-mute/60" : "text-ink-mute"
  }`;
  return (
    <table className="min-w-full divide-y divide-line text-[13px] text-ink">
      <thead className="bg-cream-2/40">
        <tr>
          <th scope="col" className={cls}>
            e-mail
          </th>
          <th scope="col" className={cls}>
            nome
          </th>
          <th scope="col" className={`${cls} text-right`}>
            listas 1.0
          </th>
          <th scope="col" className={cls}>
            status
          </th>
          <th scope="col" className={cls}>
            evidência
          </th>
          <th scope="col" className="w-8 px-3 py-2" aria-label="abrir" />
        </tr>
      </thead>
    </table>
  );
}

/* -----------------------------------------------------------------------
 * Row
 * --------------------------------------------------------------------- */

export function StatusPill({ status }: { status: MigradoStatus }) {
  const meta = MIGRADO_STATUS[status];
  const tone =
    meta.tone === "green"
      ? "border-green-300 bg-green-50 text-green-900"
      : meta.tone === "lilac"
        ? "border-lilac bg-lilac-soft/40 text-plum"
        : meta.tone === "warn"
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-line bg-cream-2/60 text-ink-soft";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] ${tone}`}
      title={meta.gloss}
      data-status={status}
    >
      {meta.label}
    </span>
  );
}

function TableRow({ row }: { row: MigradoRow }) {
  const href = row.idConta ? `/admin/usuario/${row.idConta}` : null;
  return (
    <tr
      className={`bg-paper transition-colors ${href ? "cursor-pointer hover:bg-lilac-soft/30" : ""}`}
      data-linked={href ? "true" : "false"}
    >
      <td className="px-4 py-2.5 align-middle font-mono text-[12.5px] text-ink">
        {href ? (
          <a href={href} className="block hover:text-plum">
            {row.email}
          </a>
        ) : (
          <span className="block">{row.email}</span>
        )}
      </td>
      <td className="px-4 py-2.5 align-middle text-[13px] text-ink-soft">
        {row.nomeExibicao ?? <span className="text-ink-mute">—</span>}
      </td>
      <td className="px-4 py-2.5 text-right align-middle font-mono text-[12px] tabular-nums text-ink-soft">
        {row.legacyCampaignCount}
      </td>
      <td className="px-4 py-2.5 align-middle">
        <StatusPill status={row.status} />
      </td>
      <td className="px-4 py-2.5 align-middle font-mono text-[11.5px] tabular-nums text-ink-mute">
        {row.evidencedAt ? <FormattedDate iso={row.evidencedAt} /> : "—"}
      </td>
      <td className="w-8 px-3 py-2.5 align-middle text-ink-mute">
        {href ? (
          <a href={href} tabIndex={-1} aria-hidden className="block">
            ›
          </a>
        ) : null}
      </td>
    </tr>
  );
}

function FormattedDate({ iso }: { iso: string }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{iso}</>;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return (
    <>
      {yyyy}-{mm}-{dd}
    </>
  );
}

/* -----------------------------------------------------------------------
 * States
 * --------------------------------------------------------------------- */

function SkeletonRows({ count }: { count: number }) {
  return (
    <table className="min-w-full divide-y divide-line">
      <tbody className="divide-y divide-line">
        {Array.from({ length: count }, (_, i) => (
          <tr key={i} className="bg-paper">
            <SkeletonCell width="w-2/5" />
            <SkeletonCell width="w-1/4" />
            <SkeletonCell width="w-10" />
            <SkeletonCell width="w-24" />
            <SkeletonCell width="w-20" />
            <td className="w-8 px-3 py-2.5" />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkeletonCell({ width }: { width: string }) {
  return (
    <td className="px-4 py-2.5">
      <span
        aria-hidden
        className={`block h-3.5 animate-pulse rounded-sm bg-cream-2 ${width}`}
      />
    </td>
  );
}

function EmptyState() {
  return (
    <div className="flex items-center justify-center px-4 py-16">
      <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        (nenhum usuário do 1.0 encontrado)
      </p>
    </div>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3"
    >
      <div className="space-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-red-800">
          erro ao carregar usuários migrados
        </p>
        <p className="text-[13px] text-red-900">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-red-300 bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-red-800 transition-colors hover:bg-red-100"
      >
        tentar novamente
      </button>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Footer (pagination + page-size + counter)
 * --------------------------------------------------------------------- */

function FooterShell(
  props: MigradosTableProps & { totalCount: number; rowCount: number },
) {
  const { totalCount, rowCount, startIndex, hasPrev, hasNext, onPrev, onNext } =
    props;
  const endIndex = rowCount === 0 ? 0 : startIndex + rowCount - 1;
  const navBtn =
    "rounded border border-line bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft transition-colors hover:bg-cream-2/60 hover:text-plum disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-ink-soft";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-cream-2/40 px-4 py-2.5">
      <p
        className="font-mono text-[11px] tabular-nums tracking-[0.05em] text-ink-mute"
        aria-live="polite"
      >
        {rowCount === 0 ? "0 de 0" : `${startIndex}–${endIndex} de ${totalCount}`}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
          por página
          <select
            value={props.limit}
            onChange={(e) => props.onLimitChange(Number(e.target.value))}
            className="rounded border border-line bg-paper px-2 py-1 font-mono text-[11.5px] text-ink"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={navBtn} onClick={onPrev} disabled={!hasPrev}>
          ‹ anterior
        </button>
        <button type="button" className={navBtn} onClick={onNext} disabled={!hasNext}>
          próxima ›
        </button>
      </div>
    </div>
  );
}
