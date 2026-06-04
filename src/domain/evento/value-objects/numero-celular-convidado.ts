import { z } from 'zod/v4';

const CELULAR_REGEX = /^[0-9+()\-\s]+$/;

export const NumeroCelularConvidadoSchema = z
  .string()
  .trim()
  .min(10, 'Numero de celular do convidado e curto demais')
  .max(20, 'Numero de celular do convidado e longo demais')
  .regex(CELULAR_REGEX, 'Numero de celular do convidado invalido');

export type NumeroCelularConvidado = z.infer<typeof NumeroCelularConvidadoSchema>;
