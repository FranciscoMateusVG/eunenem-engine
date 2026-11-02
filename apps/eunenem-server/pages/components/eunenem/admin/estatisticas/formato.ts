import { formatLocalDate, addDays } from "@/lib/receitaPeriodo";
import { nomeMes, rotuloMesCurto } from "@/lib/receitaPainel";

export const numero = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
export const dinheiro = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
/** R$ sem centavos, para rótulos de barra. */
export const dinheiroCurto = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
/** a/b em %, ou null sem base. */
export function pct(a: number, b: number): number | null {
  return b === 0 ? null : Math.round((a / b) * 1000) / 10;
}
export const textoPct = (p: number | null) => (p === null ? "—" : `${numero(p)}%`);

interface Bucket {
  de: string;
  ate: string;
  parcial: boolean;
}
export function rotuloBucket(b: Bucket, mensal: boolean): string {
  return mensal ? rotuloMesCurto(b.de) : formatLocalDate(b.de).slice(0, 5);
}
export function tituloBucket(b: Bucket, mensal: boolean): string {
  const nome = mensal
    ? `${nomeMes(b.de)} ${b.de.slice(0, 4)}`
    : `${formatLocalDate(b.de)} – ${formatLocalDate(addDays(b.ate, -1))}`;
  return `${nome}${b.parcial ? " (parcial)" : ""}`;
}

/** Dias com uma casa, ou "—". */
export const textoDias = (d: number | null) => (d === null ? "—" : `${numero(d)} dias`);
