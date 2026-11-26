// aperture-0ngn4 — despesas recorrentes/manuais (módulo puro, sem I/O).
//
// Valor CONHECIDO (servidor, ferramenta, assinatura), sempre confirmado.
// Mensal: cai no `diaCobranca` (1–28) de cada mês, de `inicio` a `fim`
// (inclusivo). Única: cai em `data`. Todas as datas são dias locais de SP.
// O valor de uma ocorrência é o da vigência mais recente com
// `vigenteDesde` ≤ dia da ocorrência: mudar o valor não reescreve o passado.
//
// aperture-9nmdo: mensal com `intervaloMeses` = N cobra no mês do `inicio` e
// a cada N meses depois. Uma cobrança pode ser CORRIGIDA (ajuste com nota):
// o ajuste mais recente daquela data substitui o valor só dela; o valor
// previsto (vigência) continua derivável e é exibido ao lado.

import type { Intervalo } from "./receitaPainel.js";
import { addDays, addMonthsToMonthStart, startOfMonth } from "./receitaPeriodo.js";

export const DIA_COBRANCA_MAX = 28;
export const INTERVALO_MESES_MAX = 12;

export type Recorrencia = "mensal" | "unica";

export interface VigenciaValor {
  readonly vigenteDesde: string;
  readonly valorCents: number;
}

/** Correção do valor de UMA cobrança. Em ordem de criação: a última vale. */
export interface AjusteCobranca {
  /** Data da cobrança corrigida. */
  readonly competencia: string;
  readonly valorCents: number;
  readonly nota: string;
}

export interface DespesaManual {
  readonly id: string;
  readonly nome: string;
  readonly categoria: string | null;
  readonly recorrencia: Recorrencia;
  /** Só mensal. */
  readonly diaCobranca: number | null;
  /** Só mensal: cobra a cada N meses a partir do mês do início. Ausente = 1. */
  readonly intervaloMeses?: number;
  readonly inicio: string | null;
  readonly fim: string | null;
  /** Só única. */
  readonly data: string | null;
  /** Ordenadas por `vigenteDesde`. */
  readonly valores: readonly VigenciaValor[];
  /** Ordenados por criação. Ausente = nenhum. */
  readonly ajustes?: readonly AjusteCobranca[];
}

/** Ocorrências manuais de um dia local de SP. */
export interface DiaManual {
  readonly dia: string;
  readonly manualCents: number;
  readonly ocorrencias: number;
}

/** Valor vigente num dia, ou null se nenhuma vigência começou ainda. */
export function valorVigente(valores: readonly VigenciaValor[], dia: string): number | null {
  let valor: number | null = null;
  for (const v of valores) {
    if (v.vigenteDesde <= dia) valor = v.valorCents;
  }
  return valor;
}

/** Valor de uma cobrança: o ajuste mais recente dela, ou a vigência do dia. */
export function valorDaCobranca(
  d: Pick<DespesaManual, "valores" | "ajustes">,
  dia: string,
): number | null {
  let ajuste: number | null = null;
  for (const a of d.ajustes ?? []) {
    if (a.competencia === dia) ajuste = a.valorCents;
  }
  return ajuste ?? valorVigente(d.valores, dia);
}

function indiceDoMes(dia: string): number {
  return Number(dia.slice(0, 4)) * 12 + Number(dia.slice(5, 7)) - 1;
}

/** Primeiro mês do ciclo (alinhado ao início) que contém `dia`. */
function inicioDoCiclo(d: DespesaManual, dia: string): string {
  const n = d.intervaloMeses ?? 1;
  const base = startOfMonth(d.inicio ?? dia);
  const passos = Math.floor((indiceDoMes(dia) - indiceDoMes(base)) / n);
  return addMonthsToMonthStart(base, Math.max(0, passos) * n);
}

function diaDoMes(inicioDoMes: string, dia: number): string {
  return `${inicioDoMes.slice(0, 8)}${String(dia).padStart(2, "0")}`;
}

/** Datas de cobrança de uma despesa dentro de [de, ate). */
export function datasDeCobranca(d: DespesaManual, intervalo: Intervalo): string[] {
  const dentro = (dia: string) => dia >= intervalo.de && dia < intervalo.ate;
  if (d.recorrencia === "unica") return d.data && dentro(d.data) ? [d.data] : [];
  if (!d.inicio || d.diaCobranca === null) return [];
  const datas: string[] = [];
  const n = d.intervaloMeses ?? 1;
  const primeiro = inicioDoCiclo(d, d.inicio > intervalo.de ? d.inicio : intervalo.de);
  for (let mes = primeiro; mes < intervalo.ate; mes = addMonthsToMonthStart(mes, n)) {
    const dia = diaDoMes(mes, d.diaCobranca);
    if (dia < d.inicio) continue;
    if (d.fim && dia > d.fim) break;
    if (dentro(dia)) datas.push(dia);
  }
  return datas;
}

/** Soma as ocorrências de todas as despesas por dia, dentro de [de, ate). */
export function diasManuais(
  despesas: readonly DespesaManual[],
  intervalo: Intervalo,
): DiaManual[] {
  const porDia = new Map<string, { manualCents: number; ocorrencias: number }>();
  for (const d of despesas) {
    for (const dia of datasDeCobranca(d, intervalo)) {
      const valor = valorDaCobranca(d, dia);
      if (valor === null) continue;
      const atual = porDia.get(dia) ?? { manualCents: 0, ocorrencias: 0 };
      porDia.set(dia, {
        manualCents: atual.manualCents + valor,
        ocorrencias: atual.ocorrencias + 1,
      });
    }
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dia, v]) => ({ dia, ...v }));
}

const PERIODICIDADES: Readonly<Record<number, string>> = {
  1: "mensal",
  2: "bimestral",
  3: "trimestral",
  6: "semestral",
  12: "anual",
};

/** "mensal", "trimestral", "a cada 5 meses"… */
export function nomePeriodicidade(intervaloMeses: number): string {
  return PERIODICIDADES[intervaloMeses] ?? `a cada ${intervaloMeses} meses`;
}

/** "todo dia 5 · desde 01/07/2037 · até 31/12/2037" etc. — para a lista. */
export function descreverRecorrencia(
  d: Pick<
    DespesaManual,
    "recorrencia" | "diaCobranca" | "intervaloMeses" | "inicio" | "fim" | "data"
  >,
  formatar: (data: string) => string,
): string {
  if (d.recorrencia === "unica") return d.data ? `única · ${formatar(d.data)}` : "única";
  const partes = [`${nomePeriodicidade(d.intervaloMeses ?? 1)} · todo dia ${d.diaCobranca}`];
  if (d.inicio) partes.push(`desde ${formatar(d.inicio)}`);
  if (d.fim) partes.push(`até ${formatar(d.fim)}`);
  return partes.join(" · ");
}

/**
 * "1.234,56" / "R$ 9,9" / "12.5" / "100" → centavos. Vírgula é decimal e
 * ponto é milhar; sem vírgula, um único ponto com 1–2 casas é decimal.
 * Zero, negativo ou formato ambíguo → null.
 */
export function parseValorBRL(entrada: string): number | null {
  const s = entrada.replace(/R\$/i, "").replace(/\s/g, "");
  let inteiro: string;
  let decimal = "";
  const comVirgula = /^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/.exec(s);
  const pontoDecimal = /^(\d+)\.(\d{1,2})$/.exec(s);
  const soInteiro = /^(\d{1,3}(?:\.\d{3})+|\d+)$/.exec(s);
  if (comVirgula) {
    inteiro = comVirgula[1] ?? "";
    decimal = comVirgula[2] ?? "";
  } else if (pontoDecimal) {
    inteiro = pontoDecimal[1] ?? "";
    decimal = pontoDecimal[2] ?? "";
  } else if (soInteiro) {
    inteiro = soInteiro[1] ?? "";
  } else {
    return null;
  }
  const cents = Number(inteiro.replace(/\./g, "")) * 100 + Number(decimal.padEnd(2, "0") || "0");
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Rateio de cada cobrança recorrente pelos dias do ciclo que ela cobre (o mês,
 * ou os N meses de uma despesa a cada N meses), preservando o total exato.
 * Vigências são pesos diários, não novos lançamentos; uma correção muda só o
 * total daquela cobrança. Restos vão aos primeiros dias do ciclo. */
export function diasRecorrentesRateados(
  despesas: readonly DespesaManual[],
  intervalo: Intervalo,
  cobrancasAte?: string,
): DiaManual[] {
  const result: DiaManual[] = [];
  for (const d of despesas) {
    if (d.recorrencia !== "mensal") continue;
    const n = d.intervaloMeses ?? 1;
    for (let mes = inicioDoCiclo(d, intervalo.de); mes < intervalo.ate; mes = addMonthsToMonthStart(mes, n)) {
      const fim = addMonthsToMonthStart(mes, n);
      const cobranca = datasDeCobranca(d, { de: mes, ate: addMonthsToMonthStart(mes, 1) })[0];
      if (!cobranca || (cobrancasAte && cobranca > cobrancasAte)) continue;
      const total = valorDaCobranca(d, cobranca);
      if (total === null) continue;
      const pesos: { dia: string; peso: bigint }[] = [];
      for (let dia = mes; dia < fim; dia = addDays(dia, 1)) {
        if (d.inicio && dia < d.inicio || d.fim && dia > d.fim) continue;
        const peso = valorVigente(d.valores, dia);
        if (peso !== null) pesos.push({ dia, peso: BigInt(peso) });
      }
      const soma = pesos.reduce((s, p) => s + p.peso, 0n);
      if (soma === 0n) continue;
      const partes = pesos.map(p => ({ dia: p.dia, valor: BigInt(total) * p.peso / soma }));
      let resto = BigInt(total) - partes.reduce((s, p) => s + p.valor, 0n);
      for (const p of partes) {
        const cents = Number(p.valor + (resto > 0n ? 1n : 0n));
        if (resto > 0n) resto--;
        if (p.dia >= intervalo.de && p.dia < intervalo.ate) result.push({ dia: p.dia, manualCents: cents, ocorrencias: p.dia === cobranca ? 1 : 0 });
      }
    }
  }
  return result;
}
