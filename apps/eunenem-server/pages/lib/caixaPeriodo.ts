// aperture-zoxel — período do Fluxo de caixa (módulo puro, sem I/O).
//
// Reaproveita as datas locais de São Paulo da Receita (receitaPeriodo) e
// acrescenta a granularidade "dia". Datas viajam como "YYYY-MM-DD".

import {
  addDays,
  addMonthsToMonthStart,
  isLocalDate,
  startOfIsoWeek,
  startOfMonth,
} from "./receitaPeriodo.js";

export const CAIXA_GRANULARIDADES = ["dia", "semana", "mes"] as const;
export type CaixaGranularidade = (typeof CAIXA_GRANULARIDADES)[number];

export const CAIXA_MAX_BUCKETS = 400;

export interface PeriodoCaixa {
  /** Data local SP, inclusiva. */
  readonly de: string;
  /** Data local SP, exclusiva. */
  readonly ate: string;
  readonly granularidade: CaixaGranularidade;
}

export interface BucketCaixa {
  readonly inicio: string;
  readonly fim: string;
  /** True quando o período escolhido cobre só parte do bucket. */
  readonly parcial: boolean;
}

export type PeriodoCaixaInvalido = "data_invalida" | "intervalo_vazio" | "buckets_demais";

/** Início do bucket que contém `dia`. */
export function inicioDoBucket(dia: string, granularidade: CaixaGranularidade): string {
  if (granularidade === "dia") return dia;
  return granularidade === "semana" ? startOfIsoWeek(dia) : startOfMonth(dia);
}

function proximoBucket(inicio: string, granularidade: CaixaGranularidade): string {
  if (granularidade === "dia") return addDays(inicio, 1);
  return granularidade === "semana" ? addDays(inicio, 7) : addMonthsToMonthStart(inicio, 1);
}

export function bucketsDoPeriodoCaixa(
  periodo: PeriodoCaixa,
): { ok: true; buckets: BucketCaixa[] } | { ok: false; erro: PeriodoCaixaInvalido } {
  if (!isLocalDate(periodo.de) || !isLocalDate(periodo.ate)) {
    return { ok: false, erro: "data_invalida" };
  }
  // Datas ISO "YYYY-MM-DD" ordenam lexicograficamente.
  if (periodo.de >= periodo.ate) return { ok: false, erro: "intervalo_vazio" };

  const buckets: BucketCaixa[] = [];
  let inicio = inicioDoBucket(periodo.de, periodo.granularidade);
  while (inicio < periodo.ate) {
    if (buckets.length >= CAIXA_MAX_BUCKETS) return { ok: false, erro: "buckets_demais" };
    const fim = proximoBucket(inicio, periodo.granularidade);
    buckets.push({ inicio, fim, parcial: inicio < periodo.de || fim > periodo.ate });
    inicio = fim;
  }
  return { ok: true, buckets };
}
