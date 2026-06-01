import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadgeLegend } from "@/components/eunenem/admin/DddBadge";
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIR,
  UsersTable,
  type SortBy,
  type SortDir,
} from "@/components/eunenem/admin/UsersTable";
import { ADMIN_PLATAFORMA_ID } from "@/lib/adminTenant";
import { trpc } from "@/lib/trpc.js";

// /admin — operator's DDD-trace drill-down landing.
//
// W0 (rsidz.1) shipped the bare shell with a search-as-default UserPicker.
// tinly (post-W1, child of tsrd4) flips the landing to BROWSE-AS-DEFAULT:
// a paginated UsersTable is the primary view; the filter input on top
// narrows the table. UserPicker is preserved as a sidebar quick-jump per
// Wheatley §9 recommendation (b) — a second affordance for operators who
// already know the email they want.
//
// State machine lives here; UsersTable is a pure renderer:
//   - emailPrefix (raw input) → debouncedEmailPrefix (300ms) → query
//   - sortBy, sortDir (tri-state cycle on column click)
//   - limit (25 / 50 / 100; default 50)
//   - cursor + cursorStack (for prev/next nav)
//
// Filter / sort / limit changes RESET the cursor stack to first page (per
// Wheatley §5 — reusing a cursor after a filter or sort change produces
// garbage rows because the cursor points into a different ordering).

const FILTER_DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 50;

export function AdminPage() {
  const shortPlataforma = ADMIN_PLATAFORMA_ID.slice(0, 8);

  // --- Filter ----------------------------------------------------------
  const [emailPrefix, setEmailPrefix] = useState("");
  const [debouncedEmailPrefix, setDebouncedEmailPrefix] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Sort + limit ----------------------------------------------------
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_SORT_BY);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_SORT_DIR);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);

  // --- Cursor stack ----------------------------------------------------
  // `cursor` is the cursor for the CURRENT page (null = first page).
  // `cursorStack` is the history of cursors visited so we can step back.
  // Stack invariant: cursorStack[i] is the cursor that landed us on page
  // i+1; stack.length == current page index (0-based — 0 means first page).
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  const resetCursor = useCallback(() => {
    setCursor(null);
    setCursorStack([]);
  }, []);

  // Filter debounce — clears the cursor stack as soon as the typed input
  // diverges from the debounced one (per Wheatley §5 cursor-on-filter
  // invariant). We do that synchronously on input change so the user
  // sees "page 1" semantics immediately when they start typing.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedEmailPrefix(emailPrefix.trim());
    }, FILTER_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [emailPrefix]);

  const onEmailPrefixChange = useCallback(
    (next: string) => {
      setEmailPrefix(next);
      resetCursor();
    },
    [resetCursor],
  );

  // --- Sort tri-state cycle on column click ----------------------------
  // idle (column ≠ active) → ASC → DESC → revert to default (criadoEm DESC)
  const onHeaderClick = useCallback(
    (column: SortBy) => {
      const isActive = column === sortBy;
      if (!isActive) {
        setSortBy(column);
        setSortDir("asc");
      } else if (sortDir === "asc") {
        setSortDir("desc");
      } else {
        // DESC → revert to default
        setSortBy(DEFAULT_SORT_BY);
        setSortDir(DEFAULT_SORT_DIR);
      }
      resetCursor();
    },
    [sortBy, sortDir, resetCursor],
  );

  const onLimitChange = useCallback(
    (next: number) => {
      setLimit(next);
      resetCursor();
    },
    [resetCursor],
  );

  // --- Query -----------------------------------------------------------
  const queryInput = useMemo(
    () => ({
      cursor,
      limit,
      sortBy,
      sortDir,
      emailPrefix:
        debouncedEmailPrefix === "" ? undefined : debouncedEmailPrefix,
    }),
    [cursor, limit, sortBy, sortDir, debouncedEmailPrefix],
  );

  const { data, isFetching, error, refetch } =
    trpc.admin.usuarios.listPaginated.useQuery(queryInput, {
      staleTime: 30_000,
      // Keep previous page visible during paginate / sort transitions so
      // the UI doesn't flash empty between requests.
      placeholderData: (previous) => previous,
    });

  // --- Pagination ------------------------------------------------------
  const hasNext = !!data?.nextCursor;
  const hasPrev = cursorStack.length > 0;

  const onNext = useCallback(() => {
    if (!data?.nextCursor) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(data.nextCursor);
  }, [data?.nextCursor, cursor]);

  const onPrev = useCallback(() => {
    setCursorStack((stack) => {
      if (stack.length === 0) return stack;
      const previousCursor = stack[stack.length - 1] ?? null;
      setCursor(previousCursor);
      return stack.slice(0, -1);
    });
  }, []);

  // 1-based start index. cursorStack.length tells us how many pages we've
  // advanced; each had `limit` items, so we're at page (stack.length + 1).
  const startIndex = cursorStack.length * limit + 1;

  return (
    <AdminShell
      activeBc={null}
      activeNav="landing"
      breadcrumb={[{ label: "admin" }]}
      bcContext={
        <>
          plataforma <span className="text-ink">{shortPlataforma}…</span>
        </>
      }
    >
      <section className="space-y-10">
        <Header />
        <BrowseBlock
          emailPrefix={emailPrefix}
          onEmailPrefixChange={onEmailPrefixChange}
          isFetching={isFetching}
          totalCount={data?.totalCount ?? 0}
        >
          <UsersTable
            data={data}
            isFetching={isFetching}
            error={
              error ? { message: error.message ?? "Erro desconhecido." } : null
            }
            sortBy={sortBy}
            sortDir={sortDir}
            onHeaderClick={onHeaderClick}
            limit={limit}
            onLimitChange={onLimitChange}
            hasPrev={hasPrev}
            onPrev={onPrev}
            hasNext={hasNext}
            onNext={onNext}
            startIndex={startIndex}
            onRetry={() => {
              void refetch();
            }}
          />
        </BrowseBlock>
        <Legend />
      </section>
    </AdminShell>
  );
}

function Header() {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        admin · landing
      </p>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">
        DDD-trace drill-down
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        Start from a user. Trace forward through the bounded contexts they
        touch — campanhas they administer, contribuições they made,
        pagamentos on their behalf, lançamentos financeiros that resulted.
        Every page carries the active BC badge so the model boundary stays
        visible.
      </p>
    </div>
  );
}

function BrowseBlock({
  emailPrefix,
  onEmailPrefixChange,
  isFetching,
  totalCount,
  children,
}: {
  emailPrefix: string;
  onEmailPrefixChange: (next: string) => void;
  isFetching: boolean;
  totalCount: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          usuários
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          {totalCount > 0
            ? `${totalCount} no total`
            : isFetching
              ? "carregando…"
              : "—"}
        </span>
      </div>
      <FilterInput value={emailPrefix} onChange={onEmailPrefixChange} />
      {children}
      <p className="font-mono text-[10px] tracking-[0.04em] text-ink-mute">
        Clicking a row navigates to{" "}
        <code className="text-ink-soft">/admin/usuario/[idConta]</code>.
        Use the sidebar quick-jump if you already know the email.
      </p>
    </div>
  );
}

function FilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative">
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder="Filtrar por email (prefixo)…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Filtrar usuários por prefixo de email"
        className="block w-full rounded-md border border-line bg-paper px-4 py-3 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute"
      >
        prefix
      </span>
    </div>
  );
}

function Legend() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-cream-2/40 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          bounded contexts
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          reading order
        </span>
      </div>
      <DddBadgeLegend />
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Drill pages downstream of the user pick their own BC; the badge
        appears at the top of every page so you always know which model
        you&apos;re looking at.
      </p>
    </div>
  );
}
