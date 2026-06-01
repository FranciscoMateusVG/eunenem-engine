import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * UserPicker — prefix-search dropdown for the admin landing page.
 *
 * Hits `trpc.admin.searchUsers` with a debounced prefix; renders the
 * results in a WAI-ARIA combobox dropdown. Keyboard nav (Arrow / Enter
 * / Esc) and click-outside dismiss. Selecting a row navigates to
 * `/admin/usuario/:idConta` via plain anchor click — the SSR catch-all
 * picks up the URL.
 *
 * UX contract (per rsidz.2 brief, ported from eunenem-v2 pu3h7):
 * - Empty input → no dropdown.
 * - Typing → debounced ~250ms, then fires the tRPC query.
 * - Loading state visible for ≥200ms so the spinner is observable.
 * - No matches → "Nenhum usuário encontrado".
 * - Up to 20 results.
 * - Arrow keys move the active index; Enter activates; Esc dismisses
 *   without clearing the query.
 *
 * Accessibility: combobox role on the input + listbox role on the
 * dropdown + role="option" on each row + aria-activedescendant on the
 * input. Polite live region announces result counts to screen readers.
 */

const DEBOUNCE_MS = 250;
const MIN_SPINNER_MS = 200;

export function UserPicker() {
  const listboxId = useId();

  const [query, setQuery] = useState("");
  const [debouncedPrefix, setDebouncedPrefix] = useState("");
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [isOpen, setIsOpen] = useState(false);
  const [spinnerVisible, setSpinnerVisible] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minSpinnerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the input → tRPC query input.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const next = query.trim();
    if (next === "") {
      setDebouncedPrefix("");
      return;
    }
    debounceRef.current = setTimeout(() => {
      setDebouncedPrefix(next);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const searchEnabled = debouncedPrefix !== "";
  const { data, isFetching, error } = trpc.admin.searchUsers.useQuery(
    { prefix: debouncedPrefix },
    { enabled: searchEnabled, staleTime: 30_000 },
  );

  // Ensure the spinner stays visible for at least MIN_SPINNER_MS so fast
  // responses don't make it feel buggy.
  useEffect(() => {
    if (isFetching) {
      setSpinnerVisible(true);
      return;
    }
    if (minSpinnerRef.current) clearTimeout(minSpinnerRef.current);
    minSpinnerRef.current = setTimeout(() => {
      setSpinnerVisible(false);
    }, MIN_SPINNER_MS);
    return () => {
      if (minSpinnerRef.current) clearTimeout(minSpinnerRef.current);
    };
  }, [isFetching]);

  // Click outside dismisses without clearing the query.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Derive visible state. When the query is empty we always render idle
  // regardless of any stale data.
  const trimmedQuery = query.trim();
  const isIdle = trimmedQuery === "";
  const results = !isIdle && data ? data : [];
  const noResults =
    !isIdle && !isFetching && searchEnabled && data !== undefined && data.length === 0;

  // Clamp activeIndex at render time so we never have to setState when
  // results shrink (cleaner than mirror-the-state-in-effect).
  const clampedActive =
    results.length === 0
      ? -1
      : Math.max(0, Math.min(activeIndex, results.length - 1));

  const navigateTo = useCallback((idConta: string) => {
    window.location.assign(`/admin/usuario/${idConta}`);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) setIsOpen(true);
      if (results.length === 0) return;
      const base = clampedActive < 0 ? -1 : clampedActive;
      setActiveIndex((base + 1) % results.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) setIsOpen(true);
      if (results.length === 0) return;
      const base = clampedActive < 0 ? 0 : clampedActive;
      setActiveIndex(base <= 0 ? results.length - 1 : base - 1);
      return;
    }
    if (e.key === "Enter") {
      if (results.length === 0) return;
      e.preventDefault();
      const idx = clampedActive >= 0 ? clampedActive : 0;
      const target = results[idx];
      if (target) navigateTo(target.idConta);
    }
  };

  const showDropdown =
    isOpen && !isIdle && (isFetching || spinnerVisible || data !== undefined || error !== null);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        placeholder="email, telefone ou id da conta…"
        value={query}
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-activedescendant={
          clampedActive >= 0 ? `${listboxId}-opt-${clampedActive}` : undefined
        }
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          if (!isIdle) setIsOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="block w-full rounded-md border border-line bg-paper px-4 py-3 font-mono text-[13px] text-ink placeholder:text-ink-mute focus:border-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
      />
      <RightAccessory spinning={!isIdle && (isFetching || spinnerVisible)} />

      {showDropdown && (
        <Dropdown
          id={listboxId}
          activeIndex={clampedActive}
          results={results}
          isFetching={!isIdle && (isFetching || spinnerVisible)}
          noResults={noResults}
          errorMessage={error ? error.message : null}
          onHover={setActiveIndex}
          onSelect={navigateTo}
        />
      )}

      <div aria-live="polite" role="status" className="sr-only">
        {error ? `Erro: ${error.message}` : null}
        {!error && !isIdle && data
          ? data.length === 0
            ? "Nenhum usuário encontrado."
            : `${data.length} resultado${data.length === 1 ? "" : "s"}.`
          : null}
      </div>
    </div>
  );
}

function RightAccessory({ spinning }: { spinning: boolean }) {
  if (spinning) {
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
      >
        <Spinner />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute"
    >
      ⌘K
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-plum"
    />
  );
}

function Dropdown({
  id,
  results,
  activeIndex,
  isFetching,
  noResults,
  errorMessage,
  onHover,
  onSelect,
}: {
  id: string;
  results: ReadonlyArray<{
    idConta: string;
    email: string;
    nomeExibicao: string;
  }>;
  activeIndex: number;
  isFetching: boolean;
  noResults: boolean;
  errorMessage: string | null;
  onHover: (i: number) => void;
  onSelect: (idConta: string) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      className="absolute left-0 right-0 top-full z-30 mt-2 max-h-96 overflow-auto rounded-md border border-line bg-paper shadow-md"
    >
      {errorMessage && (
        <div className="px-4 py-3 text-[13px] text-red-700">
          Erro: {errorMessage}
        </div>
      )}
      {!errorMessage && isFetching && results.length === 0 && (
        <div className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">
          buscando…
        </div>
      )}
      {!errorMessage && noResults && (
        <div className="px-4 py-3 font-mono text-[12px] tracking-[0.04em] text-ink-soft">
          Nenhum usuário encontrado.
        </div>
      )}
      {results.length > 0 && (
        <ul className="divide-y divide-line">
          {results.map((u, i) => {
            const isActive = i === activeIndex;
            return (
              <li
                key={u.idConta}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => onHover(i)}
                onClick={() => onSelect(u.idConta)}
                className={[
                  "flex cursor-pointer flex-col gap-0.5 px-4 py-2.5",
                  isActive ? "bg-lilac-soft/40" : "bg-paper",
                ].join(" ")}
              >
                <span className="font-mono text-[12px] text-ink">{u.email}</span>
                <span className="text-[12px] text-ink-soft">
                  {u.nomeExibicao}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
