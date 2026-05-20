import { z } from 'zod/v4';
import type { MoneyCents } from '../money.js';
import { MoneyCentsSchema } from '../money.js';
import type { IdCampanha, IdOpcaoContribuicao } from './campanha.js';
import { IdCampanhaSchema, IdOpcaoContribuicaoSchema } from './campanha.js';

/**
 * **Contribuição** (BC Arrecadação): item dentro de uma opção (sacola).
 * Criada pelo administrador (`disponivel`); visitante associa dados e passa a `indisponivel`.
 */
export const IdContribuicaoSchema = z.uuid();
export type IdContribuicao = z.infer<typeof IdContribuicaoSchema>;

export const NomeContribuicaoSchema = z
  .string()
  .trim()
  .min(1, 'Nome da contribuicao nao pode ser vazio')
  .max(120);

export const NomeContribuinteSchema = z
  .string()
  .trim()
  .min(1, 'Nome do contribuinte nao pode ser vazio')
  .max(120);

export const DadosContribuinteSchema = z.object({
  nome: NomeContribuinteSchema,
  email: z.string().trim().email('Email invalido').max(320),
});

export type DadosContribuinte = Readonly<z.infer<typeof DadosContribuinteSchema>>;

export const StatusContribuicaoSchema = z.enum(['disponivel', 'indisponivel']);
export type StatusContribuicao = z.infer<typeof StatusContribuicaoSchema>;

export interface Contribuicao {
  readonly id: IdContribuicao;
  readonly idCampanha: IdCampanha;
  readonly idOpcaoContribuicao: IdOpcaoContribuicao;
  readonly nome: string;
  readonly valor: MoneyCents;
  readonly contribuinte: DadosContribuinte | null;
  readonly status: StatusContribuicao;
  readonly criadaEm: Date;
}

export const CriarContribuicaoInputSchema = z.object({
  id: IdContribuicaoSchema,
  idCampanha: IdCampanhaSchema,
  idOpcaoContribuicao: IdOpcaoContribuicaoSchema,
  nome: NomeContribuicaoSchema,
  valor: MoneyCentsSchema,
});

export type CriarContribuicaoInput = z.infer<typeof CriarContribuicaoInputSchema>;

export const AssociarContribuinteContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  contribuinte: DadosContribuinteSchema,
});

export type AssociarContribuinteContribuicaoInput = z.infer<
  typeof AssociarContribuinteContribuicaoInputSchema
>;

export const AlterarValorContribuicaoInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
  valor: MoneyCentsSchema,
});

export type AlterarValorContribuicaoInput = z.infer<typeof AlterarValorContribuicaoInputSchema>;

export function contribuicaoDisponivel(contribuicao: Contribuicao): boolean {
  return contribuicao.status === 'disponivel';
}

/** Monta item disponível criado pelo administrador (sem contribuinte). */
export function criarContribuicaoDisponivel(params: {
  id: IdContribuicao;
  idCampanha: IdCampanha;
  idOpcaoContribuicao: IdOpcaoContribuicao;
  nome: string;
  valor: MoneyCents;
  criadaEm: Date;
}): Contribuicao {
  return {
    id: params.id,
    idCampanha: params.idCampanha,
    idOpcaoContribuicao: params.idOpcaoContribuicao,
    nome: params.nome,
    valor: params.valor,
    contribuinte: null,
    status: 'disponivel',
    criadaEm: params.criadaEm,
  };
}

/** Associa contribuinte e marca como indisponível. Exige status `disponivel`. */
export function contribuicaoComContribuinte(
  contribuicao: Contribuicao,
  contribuinte: DadosContribuinte,
): Contribuicao {
  if (!contribuicaoDisponivel(contribuicao)) {
    throw new Error('Contribuicao nao esta disponivel');
  }
  return {
    ...contribuicao,
    contribuinte,
    status: 'indisponivel',
  };
}

/** Altera valor apenas enquanto disponível. */
export function contribuicaoComValor(contribuicao: Contribuicao, valor: MoneyCents): Contribuicao {
  if (!contribuicaoDisponivel(contribuicao)) {
    throw new Error('Contribuicao nao esta disponivel');
  }
  return { ...contribuicao, valor };
}
