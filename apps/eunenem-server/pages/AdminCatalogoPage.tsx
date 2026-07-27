import { useId, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { ProdutosTab } from "@/components/eunenem/admin/catalogo/ProdutosTab";

/**
 * /admin/catalogo — operator-facing catalog management (plan ckru9 F1,
 * aperture-ytct2). Three tabs manage the DB-backed gift catalog that the
 * customer /painel read-path (F2, aperture-tb0rh) consumes:
 *
 *   PRODUTOS   — the product table (search / category filter / include-
 *                inactive), create/edit modal with presigned image upload,
 *                and per-row ativar/desativar (soft remove).
 *   LISTAS     — ready-made list ("lista pronta") cards, create/edit, and
 *                an item picker that reuses the /painel catalog interaction.
 *   CATEGORIAS — compact category table, create/rename/reorder, delete only
 *                when empty.
 *
 * VISUAL IDENTITY: operator workflow surface like Repasses — NO DddBadge
 * color (Catálogo is not its own BC; it's a management console). Existing
 * admin card chrome (rounded-md border-line bg-cream-2/40, mono uppercase
 * headers). Per surface-fetch-errors, every data panel renders error state
 * DISTINCTLY from empty state — never a silent-empty fallback.
 *
 * DATA LAYER (stacked-pr-verification, aperture-ytct2 build anchor):
 *   The tab bodies consume the B2 tRPC contract (aperture-d4pmw,
 *   plans/0017-catalog-api-contract.md). B2's admin.catalog.* + catalogo.*
 *   routers are not yet on origin and the contract is still being amended
 *   (admin.catalog.getList detail proc incoming). Following the house
 *   RepassesStubData playbook, each tab wires through a contract-shaped
 *   data hook so the tRPC swap is a one-file change once B2 lands and the
 *   call sites are verified against Rex's actual handler bodies.
 *
 * This module currently ships the SHELL + tab structure. Tab bodies land
 * once the amended B2 contract is final (won't merge ahead of B2 —
 * hold-the-dependent-merge).
 */

type TabKey = "produtos" | "listas" | "categorias";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "produtos", label: "Produtos" },
  { key: "listas", label: "Listas" },
  { key: "categorias", label: "Categorias" },
];

export function AdminCatalogoPage() {
  const [active, setActive] = useState<TabKey>("produtos");

  return (
    <AdminShell
      activeNav="catalogo"
      breadcrumb={[{ label: "admin", href: "/admin" }, { label: "catálogo" }]}
      bcContext={<>gestão do catálogo</>}
    >
      <section className="space-y-6">
        <SectionHeader />
        <CatalogoTabs active={active} onChange={setActive} />
        <div className="pt-1">
          <TabPanel active={active} tab="produtos">
            <ProdutosTab />
          </TabPanel>
          <TabPanel active={active} tab="listas">
            <PendingPanel
              title="Listas"
              note="listas prontas · criar/editar · seletor de itens com quantidade"
            />
          </TabPanel>
          <TabPanel active={active} tab="categorias">
            <PendingPanel
              title="Categorias"
              note="tabela · criar/renomear/reordenar · excluir apenas quando vazia"
            />
          </TabPanel>
        </div>
      </section>
    </AdminShell>
  );
}

function SectionHeader() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        catálogo
      </h2>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        produtos, listas e categorias de presentes
      </span>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Tabs — mirrors CampanhasTabs (role=tablist, arrow-key nav, border-plum
 * active). Panels stay mounted and toggle via `hidden`.
 * --------------------------------------------------------------------- */

function CatalogoTabs({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  const baseId = useId();

  function onTablistKeyDown(e: React.KeyboardEvent) {
    const idx = TABS.findIndex((t) => t.key === active);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    const nextTab = TABS[next];
    if (!nextTab) return;
    onChange(nextTab.key);
    document.getElementById(`${baseId}-tab-${nextTab.key}`)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Seções do catálogo"
      onKeyDown={onTablistKeyDown}
      className="flex items-center gap-1 border-b border-line"
    >
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            id={`${baseId}-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`${baseId}-panel-${tab.key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.key)}
            className={[
              "relative -mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors",
              isActive
                ? "border-plum text-ink"
                : "border-transparent text-ink-soft hover:text-plum",
            ].join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function TabPanel({
  active,
  tab,
  children,
}: {
  active: TabKey;
  tab: TabKey;
  children: React.ReactNode;
}) {
  const hidden = active !== tab;
  return (
    <div role="tabpanel" hidden={hidden} aria-hidden={hidden}>
      {!hidden && children}
    </div>
  );
}

/* -----------------------------------------------------------------------
 * PendingPanel — placeholder shown while the tab body waits on the B2
 * tRPC routers. Uses the admin empty-state chrome so the surface reads as
 * intentionally in-progress, not broken. Replaced tab-by-tab once the
 * amended B2 contract is final.
 * --------------------------------------------------------------------- */

function PendingPanel({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">
        {title}
      </p>
      <p className="mt-2 font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        {note}
      </p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
        aguardando API do catálogo
      </p>
    </div>
  );
}
