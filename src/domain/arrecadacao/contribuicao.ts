import { z } from 'zod/v4';
import type { MoneyCents } from '../money.js';
import type { IdCampanha, IdOpcaoContribuicao } from './campanha.js';
import { IdCampanhaSchema, IdOpcaoContribuicaoSchema } from './campanha.js';

/**
 * **Contribuição** (BC Arrecadação): vínculo entre visitante, campanha e opção escolhida.
 * O `valor` (centavos) é copiado da opção no momento da criação (imutável face a mudanças futuras na campanha).
 */
export const IdContribuicaoSchema = z.uuid();
export type IdContribuicao = z.infer<typeof IdContribuicaoSchema>;

export const NomeExibicaoContribuinteSchema = z
  .string()
  .trim()
  .min(1, 'Nome de exibicao nao pode ser vazio')
  .max(120);

export const DadosContribuinteSchema = z.object({
  nomeExibicao: NomeExibicaoContribuinteSchema,
  email: z.string().trim().email('Email invalido').max(320),
});

export type DadosContribuinte = Readonly<z.infer<typeof DadosContribuinteSchema>>;

export type StatusContribuicao = 'pendente_pagamento';

export interface Contribuicao {
  readonly id: IdContribuicao;
  readonly idCampanha: IdCampanha;
  readonly idOpcaoContribuicao: IdOpcaoContribuicao;
  readonly valor: MoneyCents;
  readonly contribuinte: DadosContribuinte;
  readonly status: StatusContribuicao;
  readonly criadaEm: Date;
}

export const CriarContribuicaoInputSchema = z.object({
  id: IdContribuicaoSchema,
  idCampanha: IdCampanhaSchema,
  idOpcaoContribuicao: IdOpcaoContribuicaoSchema,
  contribuinte: DadosContribuinteSchema,
});

export type CriarContribuicaoInput = z.infer<typeof CriarContribuicaoInputSchema>;
