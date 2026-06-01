import type { ReactNode } from "react";

/**
 * UsersTable — browse-as-default users table for /admin (aperture-tinly).
 *
 * Renders the paginated list of usuarios. The state machine (cursor stack,
 * filter, sort, limit) lives on the AdminPage owner; this component is a
 * pure renderer that takes the resolved tRPC query state + callbacks.
 *
 * Visual states (all handled here):
 *   - loading      → skeleton rows (preserves table-height stability)
 *   - error        → red banner + retry button
 *   - empty        → centered italic "(nenhum usuário encontrado)"
 *   - populated    → real rows + footer with pagination
 *
 * Sort header tri-state cycle on column click:
 *   idle → ASC → DESC → back to default (criadoEm DESC)
 * Visual arrows: ▲ ASC, ▼ DESC, "↕" idle (dim).
 *
 * Cursor-based pagination — no jump-to-page, only prev/next. The owner
 * maintains a stack of cursors visited so we can step backwards (cursor
 * pagination is forward-natural; back-stack is the client-side polyfill).
 *
 * Row click navigates to /admin/usuario/:idConta via plain anchor — SSR
 * catch-all picks up the URL and the W1 detail page (rsidz.2) renders.
 *
 * Tokens used (Visual Identity §2):
 *   bg-paper · bg-cream-2/40 · border-line · text-ink/-soft/-mute · plum
 *   font-mono for labels + IDs + pagination counter
 *   bg-lilac-soft/40 on row hover
 */

export type UsuarioAdminDTO = {
  id: string;
  idConta: string;
  email: string;
  nomeExibicao: string;
  slug: string;
  criadoEm: string; // ISO
};

export type SortBy = "criadoEm" | "email" | "nomeExibicao";
export type SortDir = "asc" | "desc";

export const DEFAULT_SORT_BY: SortBy = "criadoEm";
export const DEFAULT_SORT_DIR: SortDir = "desc";

export type ListPaginatedResult = {
  usuarios: UsuarioAdminDTO[];
  nextCursor: string | null;
  totalCount: number;
};

type UsersTableProps = {
  /** Resolved tRPC data, or undefined while loading first page. */
  data: ListPaginatedResult | undefined;
  /** Network-in-flight indicator (drives skeleton overlay on subsequent pages). */
  isFetching: boolean;
  /** tRPC error, or null. */
  error: { message: string } | null;

  /** Currently-active sort. */
  sortBy: SortBy;
  sortDir: SortDir;
  /**
   * Owner handles the tri-state cycle. Receives the column the user clicked;
   * decides next (sortBy, sortDir) based on current state.
   */
  onHeaderClick: (column: SortBy) => void;

  /** Current page-size limit. */
  limit: number;
  onLimitChange: (next: number) => void;

  /** Cursor-stack callbacks (owner maintains the stack). */
  hasPrev: boolean;
  onPrev: () => void;
  hasNext: boolean;
  onNext: () => void;

  /** Position metadata for "Mostrando N-M de TOTAL". 1-based startIndex. */
  startIndex: number;

  /** Retry callback for error state. */
  onRetry: () => void;
};

const LIMITS = [25, 50, 100] as const;

export function UsersTable(props: UsersTableProps) {
  const { data, isFetching, error } = props;

  // First-load skeleton (no data yet, no error).
  if (!data && !error && isFetching) {
    return (
      <div className="overflow-hidden rounded-md border border-line bg-paper">
        <TableHeaderRow {...props} disabled />
        <SkeletonRows count={props.limit > 10 ? 10 : props.limit} />
      </div>
    );
  }

  if (error) {
    return <ErrorBanner message={error.message} onRetry={props.onRetry} />;
  }

  // Treat undefined as empty for type safety (shouldn't happen after the
  // first-load guard above, but TypeScript needs the narrowing).
  const rows = data?.usuarios ?? [];
  const totalCount = data?.totalCount ?? 0;

  if (totalCount === 0) {
    return (
      <div className="overflow-hidden rounded-md border border-line bg-paper">
        <TableHeaderRow {...props} disabled />
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
            <TableHeader {...props} />
            <tbody className="divide-y divide-line">
              {rows.map((u) => (
                <TableRow key={u.id} usuario={u} />
              ))}
            </tbody>
          </table>
        </div>
        {/* Subsequent-page fetch overlay — keeps current rows visible but dim */}
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
 * Header
 * --------------------------------------------------------------------- */

function TableHeader(props: UsersTableProps) {
  return (
    <thead className="bg-cream-2/40">
      <tr>
        <SortHeader
          column="email"
          label="email"
          {...props}
        />
        <SortHeader
          column="nomeExibicao"
          label="nome de exibição"
          {...props}
        />
        <SortHeader
          column="criadoEm"
          label="criado em"
          {...props}
        />
        <th
          scope="col"
          aria-hidden
          className="w-8 px-3 py-2.5"
        />
      </tr>
    </thead>
  );
}

/**
 * For the skeleton + empty states the table itself doesn't render; this
 * matches the visual height of a real header so the table doesn't jump
 * when the first page lands.
 */
function TableHeaderRow(props: UsersTableProps & { disabled?: boolean }) {
  return (
    <table className="min-w-full divide-y divide-line text-[13px] text-ink">
      <TableHeader {...props} />
      <tbody />
    </table>
  );
}

function SortHeader({
  column,
  label,
  sortBy,
  sortDir,
  onHeaderClick,
}: {
  column: SortBy;
  label: string;
} & Pick<UsersTableProps, "sortBy" | "sortDir" | "onHeaderClick">) {
  const isActive = sortBy === column;
  const state: "asc" | "desc" | "idle" = isActive ? sortDir : "idle";

  const ariaSort: "ascending" | "descending" | "none" =
    state === "asc" ? "ascending" : state === "desc" ? "descending" : "none";

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className="px-4 py-2.5 text-left"
    >
      <button
        type="button"
        onClick={() => onHeaderClick(column)}
        className={[
          "group inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]",
          isActive ? "text-ink" : "text-ink-soft hover:text-plum",
        ].join(" ")}
      >
        <span>{label}</span>
        <SortGlyph state={state} />
      </button>
    </th>
  );
}

function SortGlyph({ state }: { state: "asc" | "desc" | "idle" }) {
  if (state === "asc") {
    return (
      <span aria-hidden className="text-plum">
        ▲
      </span>
    );
  }
  if (state === "desc") {
    return (
      <span aria-hidden className="text-plum">
        ▼
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="text-ink-mute opacity-50 transition-opacity group-hover:opacity-100"
    >
      ↕
    </span>
  );
}

/* -----------------------------------------------------------------------
 * Row
 * --------------------------------------------------------------------- */

function TableRow({ usuario }: { usuario: UsuarioAdminDTO }) {
  // Anchor wrapping <td> is invalid HTML — use an onClick on the <tr> with
  // an inner anchor for keyboard / screen-reader semantics on the email cell.
  return (
    <tr className="cursor-pointer bg-paper transition-colors hover:bg-lilac-soft/30">
      <td className="px-4 py-2.5 align-middle font-mono text-[12.5px] text-ink">
        <a
          href={`/admin/usuario/${usuario.idConta}`}
          className="block hover:text-plum"
        >
          {usuario.email}
        </a>
      </td>
      <td className="px-4 py-2.5 align-middle text-[13px] text-ink-soft">
        <a
          href={`/admin/usuario/${usuario.idConta}`}
          tabIndex={-1}
          className="block"
          aria-hidden
        >
          {usuario.nomeExibicao}
        </a>
      </td>
      <td className="px-4 py-2.5 align-middle font-mono text-[11.5px] text-ink-mute tabular-nums">
        <a
          href={`/admin/usuario/${usuario.idConta}`}
          tabIndex={-1}
          className="block"
          aria-hidden
        >
          <FormattedDate iso={usuario.criadoEm} />
        </a>
      </td>
      <td className="w-8 px-3 py-2.5 align-middle text-ink-mute">
        <a
          href={`/admin/usuario/${usuario.idConta}`}
          tabIndex={-1}
          aria-hidden
          className="block"
        >
          ›
        </a>
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
            <SkeletonCell width="w-3/5" />
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
        (nenhum usuário encontrado)
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
          erro ao carregar usuários
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
  props: UsersTableProps & { totalCount: number; rowCount: number },
) {
  const { totalCount, rowCount, startIndex, hasPrev, hasNext, onPrev, onNext } =
    props;

  const showingFrom = totalCount === 0 ? 0 : startIndex;
  const showingTo = totalCount === 0 ? 0 : Math.min(startIndex + rowCount - 1, totalCount);

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-cream-2/40 px-4 py-2.5">
      <Counter showingFrom={showingFrom} showingTo={showingTo} totalCount={totalCount} />
      <div className="flex items-center gap-3">
        <PageSizeSelector limit={props.limit} onChange={props.onLimitChange} />
        <PrevNext
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={onPrev}
          onNext={onNext}
        />
      </div>
    </div>
  );
}

function Counter({
  showingFrom,
  showingTo,
  totalCount,
}: {
  showingFrom: number;
  showingTo: number;
  totalCount: number;
}) {
  return (
    <p className="font-mono text-[11px] tracking-[0.04em] text-ink-soft tabular-nums">
      Mostrando{" "}
      <span className="text-ink">{showingFrom}</span>
      –
      <span className="text-ink">{showingTo}</span>
      {" de "}
      <span className="text-ink">{totalCount}</span>
      {" "}usuário{totalCount === 1 ? "" : "s"}
    </p>
  );
}

function PageSizeSelector({
  limit,
  onChange,
}: {
  limit: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
      <span>por página</span>
      <select
        value={limit}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-line bg-paper px-2 py-1 font-mono text-[11px] text-ink focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
      >
        {LIMITS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </label>
  );
}

function PrevNext({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Paginação">
      <NavButton
        onClick={onPrev}
        disabled={!hasPrev}
        aria-label="Página anterior"
      >
        ◀ Anterior
      </NavButton>
      <NavButton
        onClick={onNext}
        disabled={!hasNext}
        aria-label="Próxima página"
      >
        Próxima ▶
      </NavButton>
    </div>
  );
}

function NavButton({
  onClick,
  disabled,
  children,
  ...rest
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "rounded border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors",
        disabled
          ? "cursor-not-allowed border-line bg-paper/50 text-ink-mute"
          : "border-line bg-paper text-ink-soft hover:border-plum hover:text-plum",
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
