// aperture-dh1k7 — mês da prévia da NFS-e (módulo puro, sem I/O).
//
// O mês viaja como "YYYY-MM" na query string (`?mes=`). O default é o mês
// anterior em São Paulo: é o mês fechado que seria faturado. Mês futuro não
// existe na prévia (o servidor também recusa).

import { localDateInSaoPaulo } from "./receitaPeriodo.js";

const MES = /^(20\d{2})-(0[1-9]|1[0-2])$/;

export function isMes(value: string): boolean {
  return MES.test(value);
}

export function mesAtualSP(now: Date): string {
  return localDateInSaoPaulo(now).slice(0, 7);
}

export function mesAnterior(mes: string): string {
  const ano = Number(mes.slice(0, 4));
  const numero = Number(mes.slice(5, 7));
  return numero === 1 ? `${ano - 1}-12` : `${ano}-${String(numero - 1).padStart(2, "0")}`;
}

export function mesPadrao(now: Date): string {
  return mesAnterior(mesAtualSP(now));
}

/** `?mes=` válido e não futuro; qualquer outra coisa cai no default. */
export function mesFromSearch(search: string, now: Date): string {
  const mes = new URLSearchParams(search).get("mes") ?? "";
  return isMes(mes) && mes <= mesAtualSP(now) ? mes : mesPadrao(now);
}

export function mesToSearch(mes: string): string {
  return `?mes=${mes}`;
}
