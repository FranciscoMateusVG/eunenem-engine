import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../server/trpc/router.js";

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type FunilData = RouterOutputs["admin"]["analytics"]["funil"];
export type VendasData = RouterOutputs["admin"]["analytics"]["vendas"];
export type FunilEtapa = FunilData["etapas"][number];
export type FunilOrigem = FunilData["porOrigem"][number]["origem"];
export type SaudeData = RouterOutputs["admin"]["analytics"]["saude"];
export type SaudeRecente = SaudeData["recentes"][number];
export type SaudeCategoria = SaudeData["categorias"][number];
export type TrafegoData = RouterOutputs["admin"]["analytics"]["trafego"];
