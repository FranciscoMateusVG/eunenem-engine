import { z } from 'zod/v4';
import type { MoneyCents } from '../money.js';
import { MoneyCentsSchema } from '../money.js';

/**
 * Agregado **Campanha** (BC Arrecadação): raiz que agrupa opções de contribuição.
 * Administradores referenciam contas do sistema; recebedor é destino PIX externo (`dadosRecebedor` + `idRecebedor`).
 */
export const IdContaSchema = z.uuid();
export type IdConta = z.infer<typeof IdContaSchema>;

export const IdRecebedorSchema = z.uuid();
export type IdRecebedor = z.infer<typeof IdRecebedorSchema>;

export const IdCampanhaSchema = z.uuid();
export type IdCampanha = z.infer<typeof IdCampanhaSchema>;

export const IdOpcaoContribuicaoSchema = z.uuid();
export type IdOpcaoContribuicao = z.infer<typeof IdOpcaoContribuicaoSchema>;

export const IdsAdministradoresSchema = z
  .array(IdContaSchema)
  .min(1, 'Campanha precisa de pelo menos um administrador')
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Ids de administradores duplicados',
  });

export const TipoChavePixSchema = z.enum(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']);
export type TipoChavePix = z.infer<typeof TipoChavePixSchema>;

const apenasDigitos = (valor: string): string => valor.replace(/\D/g, '');

function mensagemChavePixInvalida(
  tipoChavePix: TipoChavePix,
  chavePix: string,
): string | undefined {
  switch (tipoChavePix) {
    case 'email':
      return z.string().email().safeParse(chavePix).success
        ? undefined
        : 'Chave PIX invalida para tipo email';
    case 'cpf': {
      const digitos = apenasDigitos(chavePix);
      return digitos.length === 11 ? undefined : 'CPF deve ter 11 digitos';
    }
    case 'cnpj': {
      const digitos = apenasDigitos(chavePix);
      return digitos.length === 14 ? undefined : 'CNPJ deve ter 14 digitos';
    }
    case 'telefone': {
      const digitos = apenasDigitos(chavePix);
      return digitos.length >= 10 && digitos.length <= 13
        ? undefined
        : 'Telefone deve ter entre 10 e 13 digitos';
    }
    case 'aleatoria':
      return z.uuid().safeParse(chavePix).success
        ? undefined
        : 'Chave aleatoria deve ser um UUID valido';
  }
}

export const DadosRecebedorSchema = z
  .object({
    nomeTitular: z.string().trim().min(1, 'Nome do titular nao pode ser vazio').max(120),
    tipoChavePix: TipoChavePixSchema,
    chavePix: z.string().trim().min(1, 'Chave PIX nao pode ser vazia').max(140),
  })
  .superRefine((dados, ctx) => {
    const mensagem = mensagemChavePixInvalida(dados.tipoChavePix, dados.chavePix);
    if (mensagem !== undefined) {
      ctx.addIssue({ code: 'custom', message: mensagem, path: ['chavePix'] });
    }
  });

export type DadosRecebedor = Readonly<z.infer<typeof DadosRecebedorSchema>>;

export const OpcaoContribuicaoSchema = z.object({
  id: IdOpcaoContribuicaoSchema,
  valor: MoneyCentsSchema,
  rotulo: z.string().trim().max(200).optional(),
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
  valor: MoneyCentsSchema,
  rotulo: z.string().trim().max(200).optional(),
});

export type AdicionarOpcaoContribuicaoInput = z.infer<typeof AdicionarOpcaoContribuicaoInputSchema>;

export const AlterarDadosRecebedorCampanhaInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  dadosRecebedor: DadosRecebedorSchema,
});

export type AlterarDadosRecebedorCampanhaInput = z.infer<
  typeof AlterarDadosRecebedorCampanhaInputSchema
>;

export const AlterarValorOpcaoContribuicaoInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
  idOpcao: IdOpcaoContribuicaoSchema,
  valor: MoneyCentsSchema,
});

export type AlterarValorOpcaoContribuicaoInput = z.infer<
  typeof AlterarValorOpcaoContribuicaoInputSchema
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

/** Substitui os dados do recebedor, imutavelmente. `idRecebedor` permanece inalterado. */
export function campanhaComDadosRecebedor(
  campanha: Campanha,
  dadosRecebedor: DadosRecebedor,
): Campanha {
  return {
    ...campanha,
    dadosRecebedor,
  };
}

/** Altera o valor de uma opção existente, imutavelmente. O caso de uso deve garantir que a opção existe. */
export function campanhaComOpcaoValor(
  campanha: Campanha,
  idOpcao: IdOpcaoContribuicao,
  valor: MoneyCents,
): Campanha {
  return {
    ...campanha,
    opcoes: campanha.opcoes.map((o) => (o.id === idOpcao ? { ...o, valor } : o)),
  };
}
