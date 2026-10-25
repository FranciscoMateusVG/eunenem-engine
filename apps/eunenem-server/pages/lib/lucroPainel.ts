import { completude, type DespesasAgregado } from "./despesasPainel.js";
import type { PainelAgregado, Intervalo } from "./receitaPainel.js";

export interface LucroPeriodo extends Intervalo {
  readonly valorCents: number | null;
  readonly estado: "completo" | "incompleto" | "sem_dados" | "futuro";
}

/** Composição, não outra query: o total de Despesas é a fonte única. */
export function agregarLucro(receita: PainelAgregado, despesas: DespesasAgregado, desde: string, hoje: string) {
  function combinar(r: PainelAgregado["meses"][number] | PainelAgregado["semanas"][number], d: DespesasAgregado["meses"][number] | DespesasAgregado["semanas"][number]): LucroPeriodo {
    if (r.de !== d.de || r.ate !== d.ate) throw new Error("lucro_intervalos_divergentes");
    const estado = r.de > hoje ? "futuro" : r.de < desde ? "sem_dados"
      : completude(d.cobertura.stripe, d.cobertura.inter) === "completo" ? "completo" : "incompleto";
    return { de: r.de, ate: r.ate, estado,
      valorCents: estado === "sem_dados" || estado === "futuro" ? null : r.tarifas.resultadoCents - d.totalCents };
  }
  if (receita.meses.length !== despesas.meses.length || receita.semanas.length !== despesas.semanas.length) throw new Error("lucro_grade_divergente");
  return {
    meses: receita.meses.map((r, i) => combinar(r, despesas.meses[i]!)),
    semanas: receita.semanas.map((r, i) => combinar(r, despesas.semanas[i]!)),
  };
}
