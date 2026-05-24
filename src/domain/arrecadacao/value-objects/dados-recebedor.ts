import { z } from 'zod/v4';

/**
 * Value object: PIX data of the receiver (nome titular + chave PIX typed by `TipoChavePix`).
 * Immutable, validated by value, no identity of its own — equality is structural.
 * Lives inside the `Recebedor` aggregate root (one active per campaign, history preserved).
 */

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
