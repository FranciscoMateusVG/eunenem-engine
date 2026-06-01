import { useCallback, useId, useState, type KeyboardEvent } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * CampanhasTabs — the Arrecadação drill on /admin/usuario/:idConta (W2).
 *
 * Two tabs:
 *   - "Administra" — campanhas this usuario OWNS. Backed by
 *     `trpc.admin.campanhas.listByUsuario({ idConta })`. Today the engine
 *     model is 0..1 per administrador, so the list is at most one row;
 *     when the port goes 1..N (`aperture-u2tko`) this UI shows N rows
 *     without changes.
 *   - "Contribuiu" — campanhas this usuario has GIVEN TO. Backed by
 *     `trpc.admin.campanhas.listByContribuinte({ email })`. Identified
 *     by email per the visitor-checkout data model (the contribuicoes
 *     table has no idConta column).
 *
 * Visual contract follows the W0/W1 admin language exactly:
 *   - font-mono labels in text-[11px] uppercase tracking-[0.14em] text-ink-soft
 *   - body in text-[13px] text-ink
 *   - hairline border-line, hover bg-lilac-soft/30
 *   - DddBadge ('arrecadacao' green) at the section head
 *
 * Accessibility (WAI-ARIA Authoring Practices, "Tabs with Manual Activation"):
 *   - role="tablist" container.
 *   - Each tab: role="tab", aria-selected, aria-controls, tabIndex 0 / -1.
 *   - Each panel: role="tabpanel", aria-labelledby, tabIndex=0.
 *   - Keyboard nav on the tablist: ←/→ moves focus + activates, Home/End,
 *     plus regular Tab to leave the strip. Manual activation pattern
 *     would skip the auto-activate on arrow, but for two cheap-to-render
 *     tabs the auto pattern is the friendlier UX. We document the choice.
 *
 * State machine per panel:
 *   - loading  → 3 skeleton rows.
 *   - error    → red banner with retry.
 *   - empty    → centered italic "(nenhuma campanha)".
 *   - loaded   → list of CampanhaRow.
 */

type TabKey = "administra" | "contribuiu";

type CampanhasTabsProps = {
  idConta: string;
  email: string;
};

export function CampanhasTabs({ idConta, email }: CampanhasTabsProps) {
  const [active, setActive] = useState<TabKey>("administra");
  const tablistId = useId();
  const administraTabId = `${tablistId}-tab-administra`;
  const contribuiuTabId = `${tablistId}-tab-contribuiu`;
  const administraPanelId = `${tablistId}-panel-administra`;
  const contribuiuPanelId = `${tablistId}-panel-contribuiu`;

  const focusTab = useCallback((key: TabKey) => {
    const id = key === "administra" ? administraTabId : contribuiuTabId;
    const el = document.getElementById(id);
    if (el instanceof HTMLElement) el.focus();
  }, [administraTabId, contribuiuTabId]);

  const onTablistKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next: TabKey = active === "administra" ? "contribuiu" : "administra";
      setActive(next);
      focusTab(next);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive("administra");
      focusTab("administra");
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive("contribuiu");
      focusTab("contribuiu");
    }
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Campanhas do usuário"
        onKeyDown={onTablistKeyDown}
        className="flex items-center gap-1 border-b border-line"
      >
        <TabButton
          id={administraTabId}
          label="Administra"
          panelId={administraPanelId}
          active={active === "administra"}
          onActivate={() => setActive("administra")}
        />
        <TabButton
          id={contribuiuTabId}
          label="Contribuiu"
          panelId={contribuiuPanelId}
          active={active === "contribuiu"}
          onActivate={() => setActive("contribuiu")}
        />
      </div>

      <div className="pt-4">
        <AdministraPanel
          id={administraPanelId}
          labelledBy={administraTabId}
          hidden={active !== "administra"}
          idConta={idConta}
        />
        <ContribuiuPanel
          id={contribuiuPanelId}
          labelledBy={contribuiuTabId}
          hidden={active !== "contribuiu"}
          email={email}
        />
      </div>
    </div>
  );
}

function TabButton({
  id,
  label,
  panelId,
  active,
  onActivate,
}: {
  id: string;
  label: string;
  panelId: string;
  active: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={panelId}
      tabIndex={active ? 0 : -1}
      onClick={onActivate}
      className={[
        "relative -mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors",
        active
          ? "border-plum text-ink"
          : "border-transparent text-ink-soft hover:text-plum",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function AdministraPanel({
  id,
  labelledBy,
  hidden,
  idConta,
}: {
  id: string;
  labelledBy: string;
  hidden: boolean;
  idConta: string;
}) {
  const { data, isLoading, error, refetch } =
    trpc.admin.campanhas.listByUsuario.useQuery(
      { idConta },
      { staleTime: 30_000 },
    );

  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
      tabIndex={0}
      className="focus:outline-none"
    >
      {!hidden && (
        <PanelBody
          isLoading={isLoading}
          error={error ? error.message : null}
          campanhas={data?.campanhas ?? null}
          onRetry={() => refetch()}
          emptyLabel="(nenhuma campanha administrada)"
        />
      )}
    </div>
  );
}

function ContribuiuPanel({
  id,
  labelledBy,
  hidden,
  email,
}: {
  id: string;
  labelledBy: string;
  hidden: boolean;
  email: string;
}) {
  const { data, isLoading, error, refetch } =
    trpc.admin.campanhas.listByContribuinte.useQuery(
      { email },
      { staleTime: 30_000 },
    );

  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
      tabIndex={0}
      className="focus:outline-none"
    >
      {!hidden && (
        <PanelBody
          isLoading={isLoading}
          error={error ? error.message : null}
          campanhas={data?.campanhas ?? null}
          onRetry={() => refetch()}
          emptyLabel="(nenhuma contribuição registrada)"
        />
      )}
    </div>
  );
}

type CampanhaRow = {
  id: string;
  titulo: string;
  status: "com-recebedor" | "sem-recebedor";
  criadaEm: string;
  recebedor: { nome: string } | null;
};

function PanelBody({
  isLoading,
  error,
  campanhas,
  onRetry,
  emptyLabel,
}: {
  isLoading: boolean;
  error: string | null;
  campanhas: ReadonlyArray<CampanhaRow> | null;
  onRetry: () => void;
  emptyLabel: string;
}) {
  if (isLoading) return <SkeletonRows />;
  if (error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800"
      >
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em]">
            erro
          </p>
          <p className="mt-1">{error}</p>
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
  if (!campanhas || campanhas.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-[13px] italic text-ink-mute">
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-paper">
      {campanhas.map((c) => (
        <li key={c.id}>
          <CampanhaListRow campanha={c} />
        </li>
      ))}
    </ul>
  );
}

function CampanhaListRow({ campanha }: { campanha: CampanhaRow }) {
  const href = `/admin/campanha/${campanha.id}`;
  const criada = formatCriadaEm(campanha.criadaEm);
  return (
    <a
      href={href}
      className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-lilac-soft/30 sm:grid-cols-[1fr_max-content_max-content]"
    >
      <div className="min-w-0">
        <p className="truncate text-[13px] text-ink">{campanha.titulo}</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
          {campanha.recebedor ? (
            <>recebedor · {campanha.recebedor.nome}</>
          ) : (
            <span className="italic">(sem recebedor)</span>
          )}
        </p>
      </div>
      <StatusPill status={campanha.status} />
      <span className="font-mono text-[11px] tabular-nums text-ink-mute">
        {criada}
      </span>
    </a>
  );
}

function StatusPill({
  status,
}: {
  status: "com-recebedor" | "sem-recebedor";
}) {
  const isOk = status === "com-recebedor";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        isOk
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-line bg-cream-2 text-ink-soft",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "inline-block size-[6px] rounded-full",
          isOk ? "bg-emerald-500" : "bg-ink-mute",
        ].join(" ")}
      />
      {isOk ? "com recebedor" : "sem recebedor"}
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul
      className="divide-y divide-line rounded-md border border-line bg-paper"
      aria-busy="true"
      aria-label="Carregando campanhas"
    >
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="grid grid-cols-[1fr_max-content_max-content] items-center gap-x-4 px-4 py-3"
        >
          <div className="space-y-1.5">
            <div className="h-3 w-48 animate-pulse rounded bg-cream-2" />
            <div className="h-2.5 w-32 animate-pulse rounded bg-cream-2" />
          </div>
          <div className="h-4 w-24 animate-pulse rounded-full bg-cream-2" />
          <div className="h-3 w-16 animate-pulse rounded bg-cream-2" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Format an ISO date string into a short pt-BR yyyy-mm-dd block. Kept
 * simple — admin view is the engineering surface, not the customer-
 * facing locale spinner. Falls back to the raw string on parse failure.
 */
function formatCriadaEm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
