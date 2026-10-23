// aperture-5qoz0 PR3 — painel Despesas (módulo puro, sem I/O).
//
// Mesma grade da Receita 1b (`gradePainel`): 12 meses, semanas do mês e os
// quatro intervalos dos KPIs, em datas locais de São Paulo. O servidor devolve
// as tarifas observadas somadas por dia de débito e as contagens de cobertura
// por dia do pagamento; aqui elas viram buckets.

import {
  type GradePainel,
  type Intervalo,
  type KpisIntervalos,
  type MesDaGrade,
  type SemanaDoMes,
} from "./receitaPainel.js";

/** Tarifas observadas de um dia local de SP (data de débito). */
export interface DiaDespesas {
  readonly dia: string;
  readonly stripeCents: number;
  readonly interCents: number;
  /** Tarifas sem pagamento vinculado: visíveis, fora do total. */
  readonly naoVinculadas: number;
  readonly naoVinculadasCents: number;
}

export interface NaoVinculadas {
  readonly count: number;
  readonly cents: number;
}

export type StatusTarifa = "confirmed" | "pending" | "failed";
export type ProvedorDespesa = "stripe" | "inter";

/**
 * Pagamentos elegíveis de um dia local de SP (data do PAGAMENTO), por
 * provedor e status da tarifa.
 */
export interface DiaCobertura {
  readonly dia: string;
  readonly provedor: ProvedorDespesa;
  readonly status: StatusTarifa;
  readonly pagamentos: number;
}

export interface ContagemCobertura {
  readonly confirmados: number;
  readonly pendentes: number;
  readonly falhos: number;
}

export interface ValoresDespesas {
  readonly stripeCents: number;
  readonly interCents: number;
  /** Stripe + Inter vinculados. Não inclui as não vinculadas. */
  readonly totalCents: number;
  readonly naoVinculadas: NaoVinculadas;
  /** Pagamentos do período (por data do pagamento) com tarifa confirmada/pendente/falha. */
  readonly cobertura: { readonly stripe: ContagemCobertura; readonly inter: ContagemCobertura };
}

export interface DespesasAgregado {
  readonly kpis: { readonly [K in keyof KpisIntervalos]: KpisIntervalos[K] & ValoresDespesas };
  readonly meses: readonly (MesDaGrade & ValoresDespesas)[];
  readonly semanas: readonly (SemanaDoMes & ValoresDespesas)[];
  /** Soma de todos os dias, para conciliar com o total independente. */
  readonly somaDosDias: {
    readonly stripeCents: number;
    readonly interCents: number;
    readonly naoVinculadasCents: number;
  };
}

function dentro(dia: string, intervalo: Intervalo): boolean {
  return dia >= intervalo.de && dia < intervalo.ate;
}

function valoresDe<T extends Intervalo>(
  intervalo: T,
  dias: readonly DiaDespesas[],
  cobertura: readonly DiaCobertura[],
): T & ValoresDespesas {
  let stripeCents = 0;
  let interCents = 0;
  let count = 0;
  let cents = 0;
  for (const d of dias) {
    if (!dentro(d.dia, intervalo)) continue;
    stripeCents += d.stripeCents;
    interCents += d.interCents;
    count += d.naoVinculadas;
    cents += d.naoVinculadasCents;
  }
  return {
    ...intervalo,
    stripeCents,
    interCents,
    totalCents: stripeCents + interCents,
    naoVinculadas: { count, cents },
    cobertura: {
      stripe: contarCobertura(cobertura, "stripe", intervalo),
      inter: contarCobertura(cobertura, "inter", intervalo),
    },
  };
}

export function agregarDespesas(
  grade: GradePainel,
  dias: readonly DiaDespesas[],
  cobertura: readonly DiaCobertura[] = [],
): DespesasAgregado {
  let stripeCents = 0;
  let interCents = 0;
  let naoVinculadasCents = 0;
  for (const d of dias) {
    // Um dia fora da janela seria valor descartado em silêncio.
    if (!dentro(d.dia, grade.janela)) throw new Error("despesas_painel_dia_fora_da_janela");
    stripeCents += d.stripeCents;
    interCents += d.interCents;
    naoVinculadasCents += d.naoVinculadasCents;
  }
  return {
    kpis: {
      mesAtual: valoresDe(grade.kpis.mesAtual, dias, cobertura),
      mesAnterior: valoresDe(grade.kpis.mesAnterior, dias, cobertura),
      semanaAtual: valoresDe(grade.kpis.semanaAtual, dias, cobertura),
      semanaAnterior: valoresDe(grade.kpis.semanaAnterior, dias, cobertura),
    },
    meses: grade.meses.map((m) => valoresDe(m, dias, cobertura)),
    semanas: grade.semanas.map((s) => valoresDe(s, dias, cobertura)),
    somaDosDias: { stripeCents, interCents, naoVinculadasCents },
  };
}

// ────────────────────────────────────────────────────────────────────
//  Cobertura
// ────────────────────────────────────────────────────────────────────

/** Sem `intervalo`: todos os dias recebidos (desde o início da coleta). */
export function contarCobertura(
  dias: readonly DiaCobertura[],
  provedor: ProvedorDespesa,
  intervalo?: Intervalo,
): ContagemCobertura {
  let confirmados = 0;
  let pendentes = 0;
  let falhos = 0;
  for (const d of dias) {
    if (d.provedor !== provedor) continue;
    if (intervalo && !dentro(d.dia, intervalo)) continue;
    if (d.status === "confirmed") confirmados += d.pagamentos;
    else if (d.status === "failed") falhos += d.pagamentos;
    else pendentes += d.pagamentos;
  }
  return { confirmados, pendentes, falhos };
}

/**
 * "completo": toda tarifa esperada foi observada. Caso contrário o valor do
 * período é só um subtotal observado; sem nada observado, não há valor.
 */
export type Completude = "completo" | "pendente" | "falha";

export function completude(...contagens: readonly ContagemCobertura[]): Completude {
  if (contagens.some((c) => c.pendentes > 0)) return "pendente";
  if (contagens.some((c) => c.falhos > 0)) return "falha";
  return "completo";
}

// ────────────────────────────────────────────────────────────────────
//  Escala da tela
// ────────────────────────────────────────────────────────────────────

/**
 * Barra empilhada de despesas: altura = total (escala única, o maior total
 * do gráfico chega a `escala`% da área); a fatia de baixo é Stripe, o resto
 * Inter. `total` é % da área; `stripe` é % da barra.
 */
export function barraDespesas(
  stripe: number,
  total: number,
  maxTotal: number,
  escala: number,
): { total: number; stripe: number } {
  if (total <= 0 || maxTotal <= 0) return { total: 0, stripe: 0 };
  return {
    total: Math.min(escala, (total / maxTotal) * escala),
    stripe: Math.min(100, Math.max(0, (stripe / total) * 100)),
  };
}
