import { z } from 'zod/v4';

export const AssinaturaConviteSchema = z
  .string()
  .trim()
  .min(1, 'Assinatura do convite nao pode ser vazia')
  .max(200, 'Assinatura do convite e longa demais');

export type AssinaturaConvite = z.infer<typeof AssinaturaConviteSchema>;
