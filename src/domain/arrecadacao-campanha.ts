import { z } from 'zod/v4';
import { MoneyCentsSchema } from './money.js';

/**
 * Agregado **Campanha** (BC Arrecadação): raiz que agrupa opções de contribuição.
 * Criador e recebedor são referências por ID (sem entidades de Usuário aqui).
 */
export const IdContaSchema = z.uuid();
export type IdConta = z.infer<typeof IdContaSchema>;

export const IdRecebedorSchema = z.uuid();
export type IdRecebedor = z.infer<typeof IdRecebedorSchema>;

export const IdCampanhaSchema = z.uuid();
export type IdCampanha = z.infer<typeof IdCampanhaSchema>;

export const IdOpcaoContribuicaoSchema = z.uuid();
export type IdOpcaoContribuicao = z.infer<typeof IdOpcaoContribuicaoSchema>;

export const OpcaoContribuicaoSchema = z.object({
  id: IdOpcaoContribuicaoSchema,
  amountCents: MoneyCentsSchema,
  rotulo: z.string().trim().max(200).optional(),
});

export type OpcaoContribuicao = Readonly<z.infer<typeof OpcaoContribuicaoSchema>>;

export interface Campanha {
  readonly id: IdCampanha;
  readonly idContaCriadora: IdConta;
  readonly idRecebedor: IdRecebedor;
  readonly titulo: string;
  readonly opcoes: readonly OpcaoContribuicao[];
  readonly criadaEm: Date;
}

export const CriarCampanhaInputSchema = z.object({
  id: IdCampanhaSchema,
  idContaCriadora: IdContaSchema,
  idRecebedor: IdRecebedorSchema,
  titulo: z.string().trim().min(1, 'Titulo nao pode ser vazio').max(200),
});

export type CriarCampanhaInput = z.infer<typeof CriarCampanhaInputSchema>;

export const AdicionarOpcaoContribuicaoInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcao: IdOpcaoContribuicaoSchema,
  amountCents: MoneyCentsSchema,
  rotulo: z.string().trim().max(200).optional(),
});

export type AdicionarOpcaoContribuicaoInput = z.infer<typeof AdicionarOpcaoContribuicaoInputSchema>;

/** Procura uma opção de contribuição na campanha (regra pura de domínio). */
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
