/**
 * PagamentosTabs — abas da seção Pagamentos (aperture-9bpre).
 *
 * São LINKS, não botões com estado: cada aba é uma rota própria, com
 * deep-link e SSR. `aria-current="page"` marca a aba ativa.
 */

export type PagamentosTab = "pagamentos" | "receita";

const TABS: ReadonlyArray<{ key: PagamentosTab; label: string; href: string }> = [
  { key: "pagamentos", label: "Pagamentos", href: "/admin/pagamentos" },
  { key: "receita", label: "Receita EuNeném", href: "/admin/pagamentos/receita" },
];

export function PagamentosTabs({ active }: { active: PagamentosTab }) {
  return (
    <nav aria-label="Seções de pagamentos" className="border-b border-line">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key} className="shrink-0">
              <a
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-4 font-mono text-[12px] uppercase tracking-[0.12em] transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-plum",
                  isActive
                    ? "border-plum text-ink"
                    : "border-transparent text-ink-soft hover:border-line hover:text-plum",
                ].join(" ")}
              >
                {tab.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
