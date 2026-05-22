import { z } from 'zod/v4';
import { type DadosRecebedor, DadosRecebedorSchema } from './dados-recebedor.js';
import {
  type IdCampanha,
  IdCampanhaSchema,
  type IdConta,
  IdContaSchema,
  type IdOpcaoContribuicao,
  IdOpcaoContribuicaoSchema,
  type IdRecebedor,
} from './ids.js';
import type { Recebedor } from './recebedor.js';

export {
  type DadosRecebedor,
  DadosRecebedorSchema,
  type TipoChavePix,
  TipoChavePixSchema,
} from './dados-recebedor.js';
export {
  type IdCampanha,
  IdCampanhaSchema,
  type IdConta,
  IdContaSchema,
  type IdOpcaoContribuicao,
  IdOpcaoContribuicaoSchema,
  type IdRecebedor,
  IdRecebedorSchema,
} from './ids.js';

/**
 * Agregado **Campanha** (BC Arrecadação): raiz que agrupa sacolas (opções por `tipo`).
 * Dados PIX do recebedor vivem em `Recebedor` (tabela `recebedores`, histórico por campanha).
 */

export const IdsAdministradoresSchema = z
  .array(IdContaSchema)
  .min(1, 'Campanha precisa de pelo menos um administrador')
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Ids de administradores duplicados',
  });

export const TipoOpcaoContribuicaoSchema = z.enum(['presente', 'rifa', 'convite']);
export type TipoOpcaoContribuicao = z.infer<typeof TipoOpcaoContribuicaoSchema>;

/** Sacola de contribuição: agrupa itens (`Contribuicao`) pelo `tipo` de experiência. */
export const OpcaoContribuicaoSchema = z.object({
  id: IdOpcaoContribuicaoSchema,
  tipo: TipoOpcaoContribuicaoSchema,
});

export type OpcaoContribuicao = Readonly<z.infer<typeof OpcaoContribuicaoSchema>>;

export interface Campanha {
  readonly id: IdCampanha;
  readonly idsAdministradores: readonly IdConta[];
  readonly idRecebedor: IdRecebedor;
  readonly dadosRecebedor: DadosRecebedor;
  readonly titulo: string;
  readonly opcoes: readonly OpcaoContribuicao[];
  readonly criadaEm: Date;
}

export const CriarCampanhaInputSchema = z.object({
  id: IdCampanhaSchema,
  idsAdministradores: IdsAdministradoresSchema,
  dadosRecebedor: DadosRecebedorSchema,
  titulo: z.string().trim().min(1, 'Titulo nao pode ser vazio').max(200),
});

export type CriarCampanhaInput = z.infer<typeof CriarCampanhaInputSchema>;

export const AdicionarOpcaoContribuicaoInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcao: IdOpcaoContribuicaoSchema,
  tipo: TipoOpcaoContribuicaoSchema,
});

export type AdicionarOpcaoContribuicaoInput = z.infer<typeof AdicionarOpcaoContribuicaoInputSchema>;

export const AlterarDadosRecebedorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  dadosRecebedor: DadosRecebedorSchema,
});

export type AlterarDadosRecebedorCampanhaInput = z.infer<
  typeof AlterarDadosRecebedorCampanhaInputSchema
>;

export const AdicionarAdministradorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idConta: IdContaSchema,
});

export type AdicionarAdministradorCampanhaInput = z.infer<
  typeof AdicionarAdministradorCampanhaInputSchema
>;

export const RemoverAdministradorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idConta: IdContaSchema,
});

export type RemoverAdministradorCampanhaInput = z.infer<
  typeof RemoverAdministradorCampanhaInputSchema
>;

/** Indica se a conta é administradora da campanha. */
export function campanhaPossuiAdministrador(campanha: Campanha, idConta: IdConta): boolean {
  return campanha.idsAdministradores.includes(idConta);
}

/** Anexa um administrador, imutavelmente. O caso de uso deve garantir ausência de duplicados. */
export function campanhaComAdministrador(campanha: Campanha, idConta: IdConta): Campanha {
  return {
    ...campanha,
    idsAdministradores: [...campanha.idsAdministradores, idConta],
  };
}

/** Remove um administrador, imutavelmente. O caso de uso deve garantir que reste pelo menos um. */
export function campanhaSemAdministrador(campanha: Campanha, idConta: IdConta): Campanha {
  return {
    ...campanha,
    idsAdministradores: campanha.idsAdministradores.filter((id) => id !== idConta),
  };
}

/** Procura uma opção de contribuição (sacola) na campanha. */
export function encontrarOpcaoContribuicao(
  campanha: Campanha,
  idOpcao: IdOpcaoContribuicao,
): OpcaoContribuicao | undefined {
  return campanha.opcoes.find((o) => o.id === idOpcao);
}

/** Anexa uma opção, imutavelmente. O caso de uso deve garantir ausência de duplicados de `opcao.id`. */
export function campanhaComOpcao(campanha: Campanha, opcao: OpcaoContribuicao): Campanha {
  return {
    ...campanha,
    opcoes: [...campanha.opcoes, opcao],
  };
}

/** Projeta na campanha o recebedor ativo. */
export function campanhaComRecebedorAtivo(campanha: Campanha, recebedor: Recebedor): Campanha {
  return {
    ...campanha,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
}

/** Monta campanha a partir de metadados e recebedor inicial ativo. */
export function campanhaComRecebedorInicial(
  params: Omit<Campanha, 'idRecebedor' | 'dadosRecebedor'> & {
    readonly recebedor: Recebedor;
  },
): Campanha {
  const { recebedor, ...rest } = params;
  return {
    ...rest,
    idRecebedor: recebedor.id,
    dadosRecebedor: recebedor.dadosRecebedor,
  };
}
