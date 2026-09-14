import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import {
  MigradosCounts,
  MigradosTable,
} from "@/components/eunenem/admin/MigradosTable";
import {
  migradosSearchInput,
  useMigradosList,
} from "@/components/eunenem/admin/migrados-contract";

// /admin/migrados — "Legado e migração" (aperture-925nx).
//
// Operator asks "who migrated?". This page lists the legacy (1.0) users from
// the server-side snapshot with the server-declared status for each
// (listed-only vs 2.0 account vs evidenced migration) — read-only, no bulk
// actions. Same state machine as AdminPage (aperture-tinly): debounced
// search (name OR email) → cursor-paginated query; filter / limit changes
// reset the cursor stack to page 1. MigradosTable is a pure renderer.
//
// Data flows through ONE seam — useMigradosList in migrados-contract.ts —
// which is swapped to Rex's approved tRPC procedure (aperture-4i05m).

const FILTER_DEBOUNCE_MS = 300;
const DEFAULT_LIMIT = 50;

export function AdminMigradosPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);

  const resetCursor = useCallback(() => {
    setCursor(null);
    setCursorStack([]);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, FILTER_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const onQueryChange = useCallback(
    (next: string) => {
      setQuery(next);
      resetCursor();
    },
    [resetCursor],
  );

  const clearQuery = useCallback(() => {
    setQuery("");
    setDebouncedQuery("");
    resetCursor();
  }, [resetCursor]);

  const onLimitChange = useCallback(
    (next: number) => {
      setLimit(next);
      resetCursor();
    },
    [resetCursor],
  );

  const queryInput = useMemo(
    () => ({ cursor, limit, ...migradosSearchInput(debouncedQuery) }),
    [cursor, limit, debouncedQuery],
  );

  const { data, isFetching, error, refetch } = useMigradosList(queryInput);

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

  const startIndex = cursorStack.length * limit + 1;

  return (
    <AdminShell
      activeBc="usuario"
      activeNav="migrados"
      breadcrumb={[{ label: "admin", href: "/admin" }, { label: "legado e migração" }]}
      bcContext={<>snapshot EuNeném 1.0 · leitura</>}
    >
      <section className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-[18px] font-semibold tracking-tight text-ink">
            Legado e migração
          </h1>
          <p className="max-w-2xl text-[13px] leading-relaxed text-ink-soft">
            Quem consta no snapshot do EuNeném 1.0 e o que o servidor consegue
            evidenciar sobre cada e-mail no 2.0. Estar na lista, ter conta ou
            perfil 2.0 criado <strong className="font-semibold text-ink">não prova</strong> que
            as listas antigas foram migradas. Status e contagens vêm do servidor;
            esta tela só lê.
          </p>
        </header>

        <MigradosCounts counts={data?.counts} />

        <MigradosSearch value={query} onChange={onQueryChange} onClear={clearQuery} />

        <MigradosTable
          data={data}
          isFetching={isFetching}
          error={error}
          limit={limit}
          onLimitChange={onLimitChange}
          hasPrev={hasPrev}
          onPrev={onPrev}
          hasNext={hasNext}
          onNext={onNext}
          startIndex={startIndex}
          onRetry={() => void refetch()}
        />
      </section>
    </AdminShell>
  );
}

export function MigradosSearch({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-[260px] flex-1 flex-col gap-1 sm:max-w-md">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-mute">
          buscar por nome ou e-mail
        </span>
        <input
          id="admin-migrados-query"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="ana@exemplo.com"
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
          className="min-h-[44px] rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-lilac focus:outline-none focus:ring-2 focus:ring-lilac-soft"
        />
      </label>
      <button
        type="button"
        onClick={onClear}
        disabled={value.length === 0}
        className="min-h-[44px] rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft transition-colors hover:bg-cream-2/60 hover:text-plum disabled:cursor-not-allowed disabled:opacity-40"
      >
        limpar
      </button>
    </div>
  );
}
