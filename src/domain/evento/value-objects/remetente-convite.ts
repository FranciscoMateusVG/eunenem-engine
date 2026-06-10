import { z } from 'zod/v4';

export const RemetenteConviteSchema = z
  .string()
  .trim()
  .min(1, 'Remetente do convite nao pode ser vazio')
  .max(120, 'Remetente do convite e longo demais');

export type RemetenteConvite = z.infer<typeof RemetenteConviteSchema>;
