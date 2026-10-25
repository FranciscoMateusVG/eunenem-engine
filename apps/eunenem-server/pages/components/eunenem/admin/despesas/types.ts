import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type DespesasPainelData = RouterOutputs["admin"]["despesas"]["painel"];
export type CoberturaDespesasData = DespesasPainelData["cobertura"]["stripe"];
export type DespesaManualData = RouterOutputs["admin"]["despesas"]["manuais"]["listar"]["despesas"][number];
