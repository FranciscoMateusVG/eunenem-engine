import { z } from 'zod/v4';

export const NomeExibidoConviteSchema = z
  .string()
  .trim()
  .min(1, 'Nome exibido nao pode ser vazio')
  .max(120, 'Nome exibido e longo demais');

export type NomeExibidoConvite = z.infer<typeof NomeExibidoConviteSchema>;
