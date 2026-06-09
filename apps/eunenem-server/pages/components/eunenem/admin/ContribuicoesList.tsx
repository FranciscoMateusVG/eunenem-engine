import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * ContribuicoesList — the Arrecadação drill inside /admin/campanha/:idCampanha
 * (aperture-rsidz.4, W3). Embedded by AdminCampanhaPage; not a standalone
 * route (operator drills user → campanha → contribuicao without an
 * intermediate listing route).
 *
 * Data: `trpc.admin.contribuicoes.listByCampanha({ idCampanha })` fetches
 * ALL contribuicoes for the campanha (v1 — no server-side pagination).
 * All filtering happens client-side via the state machine below.
 *
 * Filter state machine (Wheatley §4):
 *   - status: "todas" (default) | "disponivel" | "indisponivel"
 *     (uses the REAL StatusContribuicao enum from the engine, NOT the
 *      speculated pendente/paga/cancelada lifecycle values)
 *   - opcao:  "todas" (default) | <one chip per distinct opcao id present>
 *   - dateRange: "todo" (default) | "ultimos-7d" | "ultimos-30d" | "ultimos-90d"
 *     (date field = contribuicao.criadaEm)
 *
 * Counter: "Mostrando N de M contribuições" — N = filtered, M = total fetched.
 * Clear-link visible only when at least one filter is non-default; resets all.
 *
 * Row interaction: plain <a href> to /admin/contribuicao/:id — keeps the
 * URL changes honest (back-button works) and matches the navigation
 * pattern established by W2 (CampanhasTabs row anchors).
 *
 * Visual language: matches AdminUsuarioPage/AdminCampanhaPage exactly —
 * font-mono labels, hairline borders, no Patrick Hand (admin scope reset).
 */
export function ContribuicoesList({ idCampanha }: { idCampanha: string }) {
  const { data, isLoading, error, refetch } =
    trpc.admin.contribuicoes.listByCampanha.useQuery(
      { idCampanha },
      { staleTime: 30_000 },
    );

  const contribuicoes = data?.contribuicoes ?? null;

  if (isLoading) return <SkeletonRows />;
  if (error)
    return <ErrorBanner message={error.message} onRetry={() => refetch()} />;
  if (!contribuicoes || contribuicoes.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-[13px] italic text-ink-mute">
        (sem contribuições nesta campanha)
      </p>
    );
  }

  return <Loaded contribuicoes={contribuicoes} />;
}

// Plan 0016 Phase 4 (aperture-3htxg) — the list filter dropped the
// three-state vocabulary in favour of two: "todas" + "esgotadas". A
// future bead can introduce a "parcialmente vendida" filter if
// operators ask for it; today the count chip in each row already
// surfaces partial-sale state at a glance.
type Status = "todas" | "esgotada";
type DateRange = "todo" | "ultimos-7d" | "ultimos-30d" | "ultimos-90d";

type ContribuicaoRow = {
  id: string;
  nome: string;
  valorCentavos: number;
  // Plan 0016 Phase 4 — same (quantidade, quantidadeRestante) contract
  // the Arrecadação section reads. The list row renders the same
  // N/M-or-ESGOTADA badge so the visual identity is unified across the
  // campanha overview AND the single-contribuição drill-down.
  quantidade: number;
  quantidadeRestante: number;
  grupo: string | null;
  idOpcaoContribuicao: string;
  criadaEm: string;
  contribuinte: {
    nome: string;
    email: string;
    mensagem: string | null;
  } | null;
};

function Loaded({ contribuicoes }: { contribuicoes: ReadonlyArray<ContribuicaoRow> }) {
  const [status, setStatus] = useState<Status>("todas");
  const [opcao, setOpcao] = useState<string>("todas");
  const [dateRange, setDateRange] = useState<DateRange>("todo");

  const distinctOpcoes = useMemo(() => {
    const set = new Set<string>();
    for (const c of contribuicoes) set.add(c.idOpcaoContribuicao);
    return Array.from(set);
  }, [contribuicoes]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const rangeMs = dateRangeWindowMs(dateRange);
    return contribuicoes.filter((c) => {
      // Plan 0016 Phase 4: filter derives from the same predicate the
      // badge uses — quantidadeRestante <= 0 means "esgotada"
      // (including overshoot).
      if (status === "esgotada" && c.quantidadeRestante > 0) return false;
      if (opcao !== "todas" && c.idOpcaoContribuicao !== opcao) return false;
      if (rangeMs !== null) {
        const t = Date.parse(c.criadaEm);
        if (Number.isNaN(t)) return true; // Don't drop rows we can't parse.
        if (now - t > rangeMs) return false;
      }
      return true;
    });
  }, [contribuicoes, status, opcao, dateRange]);

  const isFiltered =
    status !== "todas" || opcao !== "todas" || dateRange !== "todo";

  const clearAll = () => {
    setStatus("todas");
    setOpcao("todas");
    setDateRange("todo");
  };

  return (
    <div className="space-y-4">
      <FilterStrip
        status={status}
        onStatus={setStatus}
        opcao={opcao}
        onOpcao={setOpcao}
        opcoesDisponiveis={distinctOpcoes}
        dateRange={dateRange}
        onDateRange={setDateRange}
      />
      <CounterRow
        filteredCount={filtered.length}
        totalCount={contribuicoes.length}
        isFiltered={isFiltered}
        onClear={clearAll}
      />
      {filtered.length === 0 ? (
        <p className="px-2 py-6 text-center text-[13px] italic text-ink-mute">
          (nenhuma contribuição corresponde aos filtros)
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-paper">
          {filtered.map((c) => (
            <li key={c.id}>
              <Row contribuicao={c} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterStrip({
  status,
  onStatus,
  opcao,
  onOpcao,
  opcoesDisponiveis,
  dateRange,
  onDateRange,
}: {
  status: Status;
  onStatus: (s: Status) => void;
  opcao: string;
  onOpcao: (id: string) => void;
  opcoesDisponiveis: ReadonlyArray<string>;
  dateRange: DateRange;
  onDateRange: (d: DateRange) => void;
}) {
  return (
    <div className="space-y-3">
      <ChipGroup
        label="status"
        chips={[
          { value: "todas", label: "Todas" },
          { value: "esgotada", label: "Esgotadas" },
        ]}
        active={status}
        onChange={(v) => onStatus(v as Status)}
      />
      {opcoesDisponiveis.length > 0 && (
        <ChipGroup
          label="opção"
          chips={[
            { value: "todas", label: "Todas" },
            ...opcoesDisponiveis.map((id) => ({
              value: id,
              // Show a short hash — full id is too long for a chip and the
              // operator drills into the row to see the full opcao id anyway.
              label: `${id.slice(0, 8)}…`,
              monoLabel: true,
            })),
          ]}
          active={opcao}
          onChange={onOpcao}
        />
      )}
      <ChipGroup
        label="período"
        chips={[
          { value: "todo", label: "Todo período" },
          { value: "ultimos-7d", label: "Últimos 7d" },
          { value: "ultimos-30d", label: "Últimos 30d" },
          { value: "ultimos-90d", label: "Últimos 90d" },
        ]}
        active={dateRange}
        onChange={(v) => onDateRange(v as DateRange)}
      />
    </div>
  );
}

function ChipGroup({
  label,
  chips,
  active,
  onChange,
}: {
  label: string;
  chips: ReadonlyArray<{
    value: string;
    label: string;
    monoLabel?: boolean;
  }>;
  active: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        {label}
      </span>
      <div
        role="group"
        aria-label={`Filtro: ${label}`}
        className="flex flex-wrap gap-1.5"
      >
        {chips.map((chip) => {
          const isActive = chip.value === active;
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(chip.value)}
              className={[
                "rounded-full border px-2.5 py-[3px] text-[11px] transition-colors",
                chip.monoLabel ? "font-mono" : "font-mono uppercase tracking-[0.12em]",
                isActive
                  ? "border-plum bg-plum text-paper"
                  : "border-line bg-paper text-ink-soft hover:border-plum hover:text-plum",
              ].join(" ")}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CounterRow({
  filteredCount,
  totalCount,
  isFiltered,
  onClear,
}: {
  filteredCount: number;
  totalCount: number;
  isFiltered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="font-mono text-[11px] tabular-nums text-ink-soft">
        Mostrando{" "}
        <span className="text-ink">{filteredCount}</span> de{" "}
        <span className="text-ink">{totalCount}</span>{" "}
        contribuiç{totalCount === 1 ? "ão" : "ões"}
      </p>
      {isFiltered && (
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-plum underline-offset-2 hover:underline"
        >
          limpar filtros
        </button>
      )}
    </div>
  );
}

function Row({ contribuicao }: { contribuicao: ContribuicaoRow }) {
  const href = `/admin/contribuicao/${contribuicao.id}`;
  return (
    <a
      href={href}
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-lilac-soft/30 sm:grid-cols-[1fr_max-content_max-content_max-content]"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] text-ink">{contribuicao.nome}</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
          {contribuicao.contribuinte ? (
            <>contribuinte · {contribuicao.contribuinte.nome}</>
          ) : (
            <span className="italic">(sem contribuinte)</span>
          )}
        </p>
      </div>
      <span className="font-mono text-[12px] tabular-nums text-ink">
        {formatBRL(contribuicao.valorCentavos)}
      </span>
      <QuantidadeBadge
        quantidade={contribuicao.quantidade}
        quantidadeRestante={contribuicao.quantidadeRestante}
      />
      <span className="font-mono text-[11px] tabular-nums text-ink-mute">
        {formatCriadaEm(contribuicao.criadaEm)}
      </span>
    </a>
  );
}

/**
 * QuantidadeBadge — Plan 0016 Phase 4 (aperture-3htxg). Same two-state
 * badge the Arrecadação section renders; duplicated here (rather than
 * imported) because the list + detail surfaces have intentionally
 * separate ownership of their visual vocabulary (the admin list is
 * its own component tree). When operators surface a third state in the
 * future (e.g. "low stock under N"), both sites swap independently.
 *
 *   - `quantidadeRestante > 0` → `N/M` count chip (emerald accent).
 *   - `quantidadeRestante <= 0` → literal `ESGOTADA` chip (stone palette,
 *     same family as the `estornado` pagamento chip — "settled past
 *     state"). Overshoot tooltip surfaces the overcount on hover.
 */
function QuantidadeBadge({
  quantidade,
  quantidadeRestante,
}: {
  quantidade: number;
  quantidadeRestante: number;
}) {
  const esgotada = quantidadeRestante <= 0;
  const vendidas = quantidade - quantidadeRestante;

  if (esgotada) {
    const overshoot = quantidadeRestante < 0 ? Math.abs(quantidadeRestante) : 0;
    const title =
      overshoot > 0
        ? `${vendidas} vendida(s) de ${quantidade} — excedeu em ${overshoot}`
        : `${vendidas} vendida(s) de ${quantidade} — esgotada`;
    return (
      <span
        title={title}
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-stone-100 px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em] text-stone-700"
      >
        <span aria-hidden className="inline-block size-[6px] rounded-full bg-stone-500" />
        esgotada
      </span>
    );
  }

  return (
    <span
      title={`${vendidas} vendida(s) de ${quantidade} — ${quantidadeRestante} restante(s)`}
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-800"
    >
      <span aria-hidden className="inline-block size-[6px] rounded-full bg-emerald-500" />
      <span className="tabular-nums">{vendidas}</span>
      <span aria-hidden className="text-emerald-700/60">/</span>
      <span className="tabular-nums">{quantidade}</span>
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul
      className="divide-y divide-line rounded-md border border-line bg-paper"
      aria-busy="true"
      aria-label="Carregando contribuições"
    >
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_max-content_max-content_max-content] items-center gap-x-4 px-4 py-3"
        >
          <div className="space-y-1.5">
            <div className="h-3 w-48 animate-pulse rounded bg-cream-2" />
            <div className="h-2.5 w-32 animate-pulse rounded bg-cream-2" />
          </div>
          <div className="h-3 w-16 animate-pulse rounded bg-cream-2" />
          <div className="h-4 w-24 animate-pulse rounded-full bg-cream-2" />
          <div className="h-3 w-16 animate-pulse rounded bg-cream-2" />
        </li>
      ))}
    </ul>
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
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800"
    >
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em]">
          erro
        </p>
        <p className="mt-1">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded border border-red-300 bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-red-800 hover:bg-red-100"
      >
        tentar de novo
      </button>
    </div>
  );
}

function dateRangeWindowMs(range: DateRange): number | null {
  switch (range) {
    case "todo":
      return null;
    case "ultimos-7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "ultimos-30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "ultimos-90d":
      return 90 * 24 * 60 * 60 * 1000;
  }
}

function formatBRL(centavos: number): string {
  const reais = centavos / 100;
  try {
    return reais.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  } catch {
    return `R$ ${reais.toFixed(2)}`;
  }
}

function formatCriadaEm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
