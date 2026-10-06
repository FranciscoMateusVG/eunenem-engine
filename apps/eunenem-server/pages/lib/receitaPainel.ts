// aperture-zn5cm — painel Receita EuNeném 1b (módulo puro, sem I/O).
//
// Grade do painel a partir de "hoje" em São Paulo: 12 meses (o atual parcial),
// semanas seg–dom do mês atual recortadas ao mês, e os quatro intervalos dos
// KPIs, em que a semana é sempre a semana inteira (atravessa a virada do mês).
// O servidor soma os dias do ledger nestes buckets; a página usa os mesmos
// rótulos e a mesma escala. Datas locais "YYYY-MM-DD", fim exclusivo.

import {
  addDays,
  addMonthsToMonthStart,
  isLocalDate,
  startOfIsoWeek,
  startOfMonth,
} from "./receitaPeriodo.js";

export const PAINEL_MESES = 12;

export interface Intervalo {
  /** Data local SP, inclusiva. */
  readonly de: string;
  /** Data local SP, exclusiva. */
  readonly ate: string;
}

export type EstadoSemana = "passada" | "atual" | "futura";

export interface SemanaDoMes extends Intervalo {
  readonly estado: EstadoSemana;
}

export interface MesDaGrade extends Intervalo {
  /** Só o mês corrente: ainda em andamento. */
  readonly parcial: boolean;
}

export interface KpisIntervalos {
  readonly mesAtual: Intervalo;
  readonly mesAnterior: Intervalo;
  readonly semanaAtual: Intervalo;
  readonly semanaAnterior: Intervalo;
}

export interface GradePainel {
  readonly hoje: string;
  readonly kpis: KpisIntervalos;
  readonly meses: readonly MesDaGrade[];
  readonly semanas: readonly SemanaDoMes[];
  /** União de tudo acima: o único intervalo que o servidor lê. */
  readonly janela: Intervalo;
}

const menor = (a: string, b: string) => (a < b ? a : b);
const maior = (a: string, b: string) => (a > b ? a : b);

export function gradePainel(hoje: string): GradePainel {
  if (!isLocalDate(hoje)) throw new Error("receita_painel_data_invalida");

  const inicioMes = startOfMonth(hoje);
  const fimMes = addMonthsToMonthStart(inicioMes, 1);
  const segunda = startOfIsoWeek(hoje);
  const kpis: KpisIntervalos = {
    mesAtual: { de: inicioMes, ate: addDays(hoje, 1) },
    mesAnterior: { de: addMonthsToMonthStart(inicioMes, -1), ate: inicioMes },
    semanaAtual: { de: segunda, ate: addDays(segunda, 7) },
    semanaAnterior: { de: addDays(segunda, -7), ate: segunda },
  };

  const meses: MesDaGrade[] = [];
  for (let i = PAINEL_MESES - 1; i >= 0; i--) {
    const de = addMonthsToMonthStart(inicioMes, -i);
    meses.push({ de, ate: addMonthsToMonthStart(de, 1), parcial: i === 0 });
  }

  const semanas: SemanaDoMes[] = [];
  for (let seg = startOfIsoWeek(inicioMes); seg < fimMes; seg = addDays(seg, 7)) {
    const proxima = addDays(seg, 7);
    semanas.push({
      de: maior(seg, inicioMes),
      ate: menor(proxima, fimMes),
      estado: seg === segunda ? "atual" : seg < segunda ? "passada" : "futura",
    });
  }

  const primeiro = meses[0]?.de ?? inicioMes;
  return {
    hoje,
    kpis,
    meses,
    semanas,
    janela: {
      de: menor(primeiro, kpis.semanaAnterior.de),
      ate: maior(fimMes, kpis.semanaAtual.ate),
    },
  };
}

// ────────────────────────────────────────────────────────────────────
//  Agregação dos dias
// ────────────────────────────────────────────────────────────────────

export interface Soma {
  readonly registradoCents: number;
  readonly canceladoCents: number;
}

export interface Metrica extends Soma {
  /** registrado − cancelado. Pode ser negativo. */
  readonly resultadoCents: number;
}

/** Um dia local de SP vindo do ledger. */
export interface DiaPainel {
  readonly dia: string;
  readonly tarifas: Soma;
  readonly recebido: Soma;
}

export interface Valores {
  readonly tarifas: Metrica;
  readonly recebido: Metrica;
}

export interface PainelAgregado {
  readonly kpis: { readonly [K in keyof KpisIntervalos]: KpisIntervalos[K] & Valores };
  readonly meses: readonly (MesDaGrade & Valores)[];
  readonly semanas: readonly (SemanaDoMes & Valores)[];
  /** Soma de todos os dias recebidos, para conciliar com o total independente. */
  readonly somaDosDias: { readonly tarifas: Soma; readonly recebido: Soma };
}

const ZERO: Soma = { registradoCents: 0, canceladoCents: 0 };

function somarSoma(a: Soma, b: Soma): Soma {
  return {
    registradoCents: a.registradoCents + b.registradoCents,
    canceladoCents: a.canceladoCents + b.canceladoCents,
  };
}

function metrica(soma: Soma): Metrica {
  return { ...soma, resultadoCents: soma.registradoCents - soma.canceladoCents };
}

function dentro(dia: string, intervalo: Intervalo): boolean {
  return dia >= intervalo.de && dia < intervalo.ate;
}

function valoresDe<T extends Intervalo>(intervalo: T, dias: readonly DiaPainel[]): T & Valores {
  let tarifas = ZERO;
  let recebido = ZERO;
  for (const d of dias) {
    if (!dentro(d.dia, intervalo)) continue;
    tarifas = somarSoma(tarifas, d.tarifas);
    recebido = somarSoma(recebido, d.recebido);
  }
  return { ...intervalo, tarifas: metrica(tarifas), recebido: metrica(recebido) };
}

export function agregarDias(grade: GradePainel, dias: readonly DiaPainel[]): PainelAgregado {
  let tarifas = ZERO;
  let recebido = ZERO;
  for (const d of dias) {
    // Um dia fora da janela seria valor descartado em silêncio.
    if (!dentro(d.dia, grade.janela)) throw new Error("receita_painel_dia_fora_da_janela");
    tarifas = somarSoma(tarifas, d.tarifas);
    recebido = somarSoma(recebido, d.recebido);
  }
  return {
    kpis: {
      mesAtual: valoresDe(grade.kpis.mesAtual, dias),
      mesAnterior: valoresDe(grade.kpis.mesAnterior, dias),
      semanaAtual: valoresDe(grade.kpis.semanaAtual, dias),
      semanaAnterior: valoresDe(grade.kpis.semanaAnterior, dias),
    },
    meses: grade.meses.map((m) => valoresDe(m, dias)),
    semanas: grade.semanas.map((s) => valoresDe(s, dias)),
    somaDosDias: { tarifas, recebido },
  };
}

// ────────────────────────────────────────────────────────────────────
//  Escala e rótulos da tela
// ────────────────────────────────────────────────────────────────────

/**
 * Barras pareadas, cada série na própria escala. `max` é a altura do grupo em
 * % da área (a maior das duas, mínimo 1); `t` e `r` são % do grupo.
 */
export function alturasPareadas(
  tarifas: number,
  recebido: number,
  maxTarifas: number,
  maxRecebido: number,
  escala: number,
): { max: number; t: number; r: number } {
  const h = (v: number, m: number) => (m > 0 ? Math.max(0, (v / m) * escala) : 0);
  const hT = h(tarifas, maxTarifas);
  const hR = h(recebido, maxRecebido);
  const max = Math.max(hT, hR, 1);
  return { max, t: (hT / max) * 100, r: (hR / max) * 100 };
}

const INTEIRO = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const MIL = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

/** "R$ 3,4 mil" / "R$ 512": rótulo curto das barras mensais. */
export function formatCompacto(cents: number): string {
  const sinal = cents < 0 ? "-" : "";
  const reais = Math.abs(cents) / 100;
  if (reais >= 1000) return `${sinal}R$ ${MIL.format(reais / 1000)} mil`;
  return `${sinal}R$ ${INTEIRO.format(Math.round(reais))}`;
}

function partes(data: string): { dia: string; mes: string; ano: string } {
  return { ano: data.slice(0, 4), mes: data.slice(5, 7), dia: data.slice(8, 10) };
}

/** Primeiro e último dia incluídos no intervalo. */
function extremos(intervalo: Intervalo) {
  return { a: partes(intervalo.de), b: partes(addDays(intervalo.ate, -1)) };
}

function faixa(intervalo: Intervalo, separador: string, compactarMes: boolean): string {
  const { a, b } = extremos(intervalo);
  if (a.dia === b.dia && a.mes === b.mes && a.ano === b.ano) return `${a.dia}/${a.mes}`;
  if (compactarMes && a.mes === b.mes) return `${a.dia}${separador}${b.dia}/${b.mes}`;
  return `${a.dia}/${a.mes}${separador}${b.dia}/${b.mes}`;
}

/** Rótulo da barra semanal: "05–11/10", "28/09–04/10", "01/11". */
export function rotuloSemana(intervalo: Intervalo): string {
  return faixa(intervalo, "–", true);
}

/** Faixa do KPI de semana: "05 – 11/10", "28/09 – 04/10". */
export function faixaKpiSemana(intervalo: Intervalo): string {
  return faixa(intervalo, " – ", true);
}

/** Faixa do KPI de mês: "01/10 – 05/10". */
export function faixaKpiMes(intervalo: Intervalo): string {
  return faixa(intervalo, " – ", false);
}

const DIAS_DA_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

function diaDaSemana(data: string): string {
  const { ano, mes, dia } = partes(data);
  const weekday = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia))).getUTCDay();
  return DIAS_DA_SEMANA[weekday] ?? "";
}

/** Nota sob a barra: "esta semana", o recorte de uma semana passada, ou nada. */
export function notaSemana(semana: SemanaDoMes): string {
  if (semana.estado === "atual") return "esta semana";
  if (semana.estado === "futura" || addDays(semana.de, 7) === semana.ate) return "";
  const primeiro = diaDaSemana(semana.de);
  const ultimo = diaDaSemana(addDays(semana.ate, -1));
  return primeiro === ultimo ? primeiro : `${primeiro} a ${ultimo}`;
}

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/** "setembro" para qualquer data do mês. */
export function nomeMes(data: string): string {
  return MESES[Number(partes(data).mes) - 1] ?? "";
}

/** "nov/25". */
export function rotuloMesCurto(data: string): string {
  return `${nomeMes(data).slice(0, 3)}/${partes(data).ano.slice(2)}`;
}
