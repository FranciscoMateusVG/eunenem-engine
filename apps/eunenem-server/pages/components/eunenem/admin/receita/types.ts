import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ReceitaDashboard = RouterOutputs["admin"]["receita"]["dashboard"];
export type ReceitaCard = ReceitaDashboard["cards"]["periodo"];
export type ReceitaBucket = ReceitaDashboard["serie"][number];
export type ReceitaCampanha = ReceitaDashboard["porCampanha"]["rows"][number];
export type ReceitaMeioProvedor = ReceitaDashboard["porMeioProvedor"][number];
export type ReceitaCampanhasPage = RouterOutputs["admin"]["receita"]["campanhasPaginated"];

/** Rótulos canônicos. Nunca "lucro" nem valor "líquido": a fonte não os conhece. */
export const ROTULOS = {
  receita: "Receita EuNeném (taxa da plataforma)",
  registradas: "Taxas registradas",
  cancelamentos: "Cancelamentos",
  resultado: "Resultado de taxas",
  adicional: "Adicional de cartão (repasse, não é receita)",
} as const;

export function formatInstante(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}
