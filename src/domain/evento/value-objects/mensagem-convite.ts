import { z } from 'zod/v4';

export const MensagemConviteSchema = z
  .string()
  .trim()
  .min(1, 'Mensagem do convite nao pode ser vazia')
  .max(2000, 'Mensagem do convite e longa demais');

export type MensagemConvite = z.infer<typeof MensagemConviteSchema>;
