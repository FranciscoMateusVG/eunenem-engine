import {
  hrefSecao,
  isMesesPeriodo,
  MESES_OPCOES,
  type MesesPeriodo,
  SECOES,
  type SecaoEstatisticas,
} from "@/lib/estatisticasSecoes";

/**
 * Abas de Estatísticas (aperture-lcug3). São LINKS, como em PagamentosTabs:
 * cada seção é uma rota própria. O período escolhido segue junto no href.
 */
export function EstatisticasTabs({
  active,
  meses,
}: {
  active: SecaoEstatisticas;
  meses: MesesPeriodo;
}) {
  return (
    <nav aria-label="Seções de estatísticas" className="border-b border-line">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {SECOES.map((secao) => {
          const isActive = secao.key === active;
          return (
            <li key={secao.key} className="shrink-0">
              <a
                href={hrefSecao(secao.key, meses)}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-4 font-mono text-[12px] uppercase tracking-[0.12em] transition-colors",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-plum",
                  isActive
                    ? "border-plum text-ink"
                    : "border-transparent text-ink-soft hover:border-line hover:text-plum",
                ].join(" ")}
              >
                {secao.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Seletor 3/6/12 meses, o mesmo de todas as seções. */
export function PeriodoSelect({
  meses,
  onChange,
}: {
  meses: MesesPeriodo;
  onChange: (meses: MesesPeriodo) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      Período
      <select
        aria-label="Período mensal"
        className="rounded-lg border border-line bg-white p-2"
        value={meses}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (isMesesPeriodo(n)) onChange(n);
        }}
      >
        {MESES_OPCOES.map((n) => (
          <option key={n} value={n}>
            Últimos {n} meses
          </option>
        ))}
      </select>
    </label>
  );
}
