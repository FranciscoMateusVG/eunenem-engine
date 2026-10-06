import { z } from 'zod/v4';

/** Write-only policy. Historical gift values remain readable. */
export const VALOR_UNITARIO_PRESENTE_MINIMO_CENTS = 1_000;

export const VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE =
  'o valor por unidade deve ser de pelo menos R$ 10,00';

export const ValorUnitarioPresenteWriteSchema = z
  .number()
  .int()
  .min(VALOR_UNITARIO_PRESENTE_MINIMO_CENTS, VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE);

export type ValorUnitarioPresenteWrite = z.infer<typeof ValorUnitarioPresenteWriteSchema>;
