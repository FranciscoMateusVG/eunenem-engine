import { z } from 'zod/v4';
import type { MoneyCents } from '../../money.js';
import type { DadosContribuinte } from '../value-objects/dados-contribuinte.js';
import type { IdCampanha, IdContribuicao, IdOpcaoContribuicao } from '../value-objects/ids.js';

/**
 * @aggregateRoot Contribuição (BC Arrecadação)
 *
 * Item inside an opção (sacola). Created by the admin as `disponivel`; the
 * visitor associates `DadosContribuinte` and the item flips to `indisponivel`.
 *
 * Persisted via: `ContribuicaoRepository`.
 *
 * Aggregate boundary: status transitions and contribuinte association happen
 * atomically through this root. References Campanha + OpcaoContribuicao by ID
 * only — never imports those aggregates.
 *
 * `StatusContribuicao` and `NomeContribuicao` are inlined here as intrinsic
 * field schemas (tightly bound to this entity's invariants).
 */

export const StatusContribuicaoSchema = z.enum(['disponivel', 'indisponivel']);
export type StatusContribuicao = z.infer<typeof StatusContribuicaoSchema>;

export const NomeContribuicaoSchema = z
  .string()
  .trim()
  .min(1, 'Nome da contribuicao nao pode ser vazio')
  .max(120);

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

/**
 * Remove o contribuinte e devolve a contribuição ao estado `disponivel`.
 * Usado como **compensação** na saga de checkout: se um passo posterior
 * falhar (cálculo de composição, criação do pagamento), o orquestrador
 * desfaz a associação. Exige `status === 'indisponivel'`.
 */
export function contribuicaoSemContribuinte(contribuicao: Contribuicao): Contribuicao {
  if (contribuicaoDisponivel(contribuicao)) {
    throw new Error('Contribuicao ja esta disponivel');
  }
  return {
    ...contribuicao,
    contribuinte: null,
    status: 'disponivel',
  };
}
