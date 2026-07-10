import { z } from 'zod/v4';

/**
 * Value object: the receiver's payout data — a DISCRIMINATED UNION by
 * `metodo` (aperture-mcvyw):
 *   - `metodo: 'pix'`   → nome titular + cpf titular + a typed PIX key.
 *   - `metodo: 'conta'` → nome titular + full Brazilian bank-account coords
 *                         (incl. cpf titular).
 *
 * Both variants carry `cpfTitular` (checksum-validated) — the payout must
 * be traceable to the account holder's CPF regardless of rail.
 *
 * Immutable, validated by value, no identity of its own — equality is
 * structural. Lives inside the `Recebedor` aggregate root (one active per
 * campaign, history preserved).
 *
 * ⚠️ NO bank-transfer rail exists yet: a `'conta'` receiver is PERSISTED but
 * NOT payable via the PIX repasse path. The withdrawal orchestrator
 * (`iniciarRepasseRecebedor`) short-circuits `'conta'` with a typed error so
 * it never reaches the cents-sweep. Manual payout is the operator's job.
 *
 * Enum note: the domain key type is `'telefone'` (NOT the frontend's
 * `'celular'`); the frontend bridges the label before it hits the wire.
 */

export const TipoChavePixSchema = z.enum(['cpf', 'cnpj', 'email', 'telefone', 'aleatoria']);
export type TipoChavePix = z.infer<typeof TipoChavePixSchema>;

/** cc=corrente, cp=poupança, pg=pagamento, csl=conta-salário. */
export const TipoContaSchema = z.enum(['cc', 'cp', 'pg', 'csl']);
export type TipoConta = z.infer<typeof TipoContaSchema>;

export const METODO_RECEBIMENTO = ['pix', 'conta'] as const;

const apenasDigitos = (valor: string): string => valor.replace(/\D/g, '');

/**
 * Real CPF check-digit validation (not just length). Rejects the known
 * all-same-digit fakes (000…, 111…, etc.) which pass the checksum.
 */
export function cpfValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  const calc = (fim: number): number => {
    let soma = 0;
    for (let i = 0; i < fim; i++) {
      soma += Number(d[i]) * (fim + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

/** Real CNPJ check-digit validation. */
export function cnpjValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (fim: number): number => {
    const pesos =
      fim === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < fim; i++) {
      soma += Number(d[i]) * (pesos[i] ?? 0);
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/**
 * Brazilian mobile in E.164-ish form: 10–13 digits (DDD + number, optional
 * country code 55). We store digits-only; the frontend renders the mask.
 */
export function telefoneBrValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  return d.length >= 10 && d.length <= 13;
}

/** Per-type PIX-key format/checksum validation. Returns an error message or undefined. */
export function mensagemChavePixInvalida(
  tipoChavePix: TipoChavePix,
  chavePix: string,
): string | undefined {
  switch (tipoChavePix) {
    case 'email':
      return z.string().email().safeParse(chavePix).success
        ? undefined
        : 'Chave PIX invalida para tipo email';
    case 'cpf':
      return cpfValido(chavePix) ? undefined : 'CPF invalido (digitos verificadores)';
    case 'cnpj':
      return cnpjValido(chavePix) ? undefined : 'CNPJ invalido (digitos verificadores)';
    case 'telefone':
      return telefoneBrValido(chavePix) ? undefined : 'Telefone deve ter entre 10 e 13 digitos';
    case 'aleatoria':
      return z.uuid().safeParse(chavePix).success
        ? undefined
        : 'Chave aleatoria deve ser um UUID valido';
  }
}

// ─── Union members (plain objects so discriminatedUnion can read `metodo`) ───

const nomeTitular = z.string().trim().min(1, 'Nome do titular nao pode ser vazio').max(120);

export const DadosRecebedorPixSchema = z.object({
  metodo: z.literal('pix'),
  nomeTitular,
  /** Account holder's CPF — checksum-validated, same rule as the conta branch. */
  cpfTitular: z.string().trim().min(1).max(20),
  tipoChavePix: TipoChavePixSchema,
  chavePix: z.string().trim().min(1, 'Chave PIX nao pode ser vazia').max(140),
});

export const DadosRecebedorContaSchema = z.object({
  metodo: z.literal('conta'),
  nomeTitular,
  /** Account holder's CPF — checksum-validated. */
  cpfTitular: z.string().trim().min(1).max(20),
  /** Holder's mobile — digits-only, 10–13. */
  celularTitular: z.string().trim().min(1).max(20),
  /** COMPE 3-digit bank code (e.g. '001', '237', '260'). */
  codigoBanco: z
    .string()
    .trim()
    .regex(/^\d{3}$/, 'Codigo do banco deve ter 3 digitos (COMPE)'),
  agencia: z
    .string()
    .trim()
    .regex(/^\d{1,10}$/, 'Agencia deve ser numerica'),
  /** Agency check-digit — optional (some banks have none). */
  agenciaDigito: z.string().trim().max(2).nullable(),
  conta: z
    .string()
    .trim()
    .regex(/^\d{1,20}$/, 'Conta deve ser numerica'),
  contaDigito: z.string().trim().min(1).max(2),
  tipoConta: TipoContaSchema,
});

/**
 * The receiver-data union. Cross-field validation (PIX-key-by-type,
 * CPF checksum) lives in a union-level `superRefine` — keeping the
 * discriminatedUnion members plain objects so the `metodo` discriminator
 * resolves cleanly.
 */
export const DadosRecebedorSchema = z
  .discriminatedUnion('metodo', [DadosRecebedorPixSchema, DadosRecebedorContaSchema])
  .superRefine((dados, ctx) => {
    if (!cpfValido(dados.cpfTitular)) {
      ctx.addIssue({
        code: 'custom',
        message: 'CPF do titular invalido (digitos verificadores)',
        path: ['cpfTitular'],
      });
    }
    if (dados.metodo === 'pix') {
      const mensagem = mensagemChavePixInvalida(dados.tipoChavePix, dados.chavePix);
      if (mensagem !== undefined) {
        ctx.addIssue({ code: 'custom', message: mensagem, path: ['chavePix'] });
      }
      return;
    }
    // metodo === 'conta'
    if (!telefoneBrValido(dados.celularTitular)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Celular do titular deve ter entre 10 e 13 digitos',
        path: ['celularTitular'],
      });
    }
  });

export type DadosRecebedor = Readonly<z.infer<typeof DadosRecebedorSchema>>;
export type DadosRecebedorPix = Readonly<z.infer<typeof DadosRecebedorPixSchema>>;
export type DadosRecebedorConta = Readonly<z.infer<typeof DadosRecebedorContaSchema>>;
