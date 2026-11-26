import { z } from 'zod/v4';

/**
 * Value object: endereço fiscal do recebedor — o tomador da NFS-e mensal
 * (aperture-xdylg). Obrigatório para resgatar (decisão do contador,
 * 26/11/2026).
 *
 * Limites do leiaute DPS SN NFS-e v1.01 (TCEndereco com endNac): CEP 8
 * dígitos, código IBGE do município 7 dígitos, logradouro ≤ 255, número
 * ≤ 60, complemento ≤ 156 (opcional), bairro ≤ 60, texto Latin-1 sem espaço
 * nas pontas (TSString). O código IBGE tem de ser da UF informada (os dois
 * primeiros dígitos são o código da UF). `cidade` é só para exibição; a DPS
 * leva o código.
 */

/** Código IBGE da UF (2 dígitos) → sigla. */
const UF_POR_CODIGO: Readonly<Record<string, string>> = {
  '11': 'RO',
  '12': 'AC',
  '13': 'AM',
  '14': 'RR',
  '15': 'PA',
  '16': 'AP',
  '17': 'TO',
  '21': 'MA',
  '22': 'PI',
  '23': 'CE',
  '24': 'RN',
  '25': 'PB',
  '26': 'PE',
  '27': 'AL',
  '28': 'SE',
  '29': 'BA',
  '31': 'MG',
  '32': 'ES',
  '33': 'RJ',
  '35': 'SP',
  '41': 'PR',
  '42': 'SC',
  '43': 'RS',
  '50': 'MS',
  '51': 'MT',
  '52': 'GO',
  '53': 'DF',
};

export const UFS = Object.values(UF_POR_CODIGO).sort();

export function ufDoCodigoIbge(codigo: string): string | null {
  return UF_POR_CODIGO[codigo.slice(0, 2)] ?? null;
}

/** Latin-1 imprimível, sem espaço nas pontas (TSString do XSD). */
const LATIN1 = /^[!-ÿ](?:[ -ÿ]*[!-ÿ])?$/;

const texto = (max: number, rotulo: string) =>
  z
    .string()
    .trim()
    .min(1, `${rotulo} é obrigatório`)
    .max(max, `${rotulo} deve ter no máximo ${max} caracteres`)
    .regex(LATIN1, `${rotulo} tem caracteres inválidos`);

export const EnderecoFiscalSchema = z
  .object({
    cep: z
      .string()
      .transform((v) => v.replace(/\D/g, ''))
      .pipe(z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos')),
    logradouro: texto(255, 'Logradouro'),
    numero: texto(60, 'Número'),
    complemento: z
      .string()
      .trim()
      .max(156, 'Complemento deve ter no máximo 156 caracteres')
      .regex(/^(|[!-ÿ](?:[ -ÿ]*[!-ÿ])?)$/, 'Complemento tem caracteres inválidos')
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
    bairro: texto(60, 'Bairro'),
    cidade: texto(60, 'Cidade'),
    uf: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(UFS as [string, ...string[]], 'UF inválida')),
    codigoMunicipioIbge: z
      .string()
      .trim()
      .regex(/^\d{7}$/, 'Código IBGE do município deve ter 7 dígitos'),
  })
  .superRefine((e, ctx) => {
    if (ufDoCodigoIbge(e.codigoMunicipioIbge) !== e.uf) {
      ctx.addIssue({
        code: 'custom',
        message: 'Código IBGE do município não pertence à UF informada',
        path: ['codigoMunicipioIbge'],
      });
    }
  });

export type EnderecoFiscal = Readonly<z.infer<typeof EnderecoFiscalSchema>>;
