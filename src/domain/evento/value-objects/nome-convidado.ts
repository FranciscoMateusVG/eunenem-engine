import { z } from 'zod/v4';

export const NomeConvidadoSchema = z
  .string()
  .trim()
  .min(1, 'Nome do convidado nao pode ser vazio')
  .max(120, 'Nome do convidado e longo demais');

export type NomeConvidado = z.infer<typeof NomeConvidadoSchema>;
