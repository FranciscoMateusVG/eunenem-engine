// aperture-lcug3 — sub-seções de Estatísticas (módulo puro, sem I/O).
//
// Cada seção é uma rota própria (deep-link + SSR). O período (3/6/12 meses)
// viaja como `?meses=` para sobreviver à troca de aba; 3 é o default e não
// aparece na URL.

export type SecaoEstatisticas = "funil" | "vendas" | "listas" | "financeiro" | "trafego" | "saude";
export type MesesPeriodo = 3 | 6 | 12;

export const MESES_OPCOES: readonly MesesPeriodo[] = [3, 6, 12];
export const MESES_PADRAO: MesesPeriodo = 3;

export const SECOES: ReadonlyArray<{ key: SecaoEstatisticas; label: string; path: string }> = [
  { key: "funil", label: "Funil", path: "/admin/estatisticas" },
  { key: "vendas", label: "Vendas", path: "/admin/estatisticas/vendas" },
  { key: "listas", label: "Listas", path: "/admin/estatisticas/listas" },
  { key: "financeiro", label: "Financeiro", path: "/admin/estatisticas/financeiro" },
  { key: "trafego", label: "Tráfego", path: "/admin/estatisticas/trafego" },
  { key: "saude", label: "Saúde & erros", path: "/admin/estatisticas/saude" },
];

/** Seção da rota, ou null se o caminho não é de Estatísticas. */
export function secaoFromPath(pathname: string): SecaoEstatisticas | null {
  const normal = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return SECOES.find((s) => s.path === normal)?.key ?? null;
}

export function isMesesPeriodo(n: number): n is MesesPeriodo {
  return n === 3 || n === 6 || n === 12;
}

/** `?meses=` válido; qualquer outra coisa cai no default. */
export function mesesFromSearch(search: string): MesesPeriodo {
  const n = Number(new URLSearchParams(search).get("meses"));
  return isMesesPeriodo(n) ? n : MESES_PADRAO;
}

export function hrefSecao(secao: SecaoEstatisticas, meses: MesesPeriodo): string {
  const path = SECOES.find((s) => s.key === secao)!.path;
  return meses === MESES_PADRAO ? path : `${path}?meses=${meses}`;
}
