import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type FunilData = RouterOutputs["admin"]["analytics"]["funil"];
export type VendasData = RouterOutputs["admin"]["analytics"]["vendas"];
export type FunilEtapa = FunilData["etapas"][number];
export type FunilOrigem = FunilData["porOrigem"][number]["origem"];
