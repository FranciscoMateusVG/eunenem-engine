import { z } from 'zod/v4';

export const PaletaConviteSchema = z.enum([
  'lilas',
  'rosa-coral',
  'verde-limao',
  'azul-claro',
  'amarelo',
  'cream',
  'surpresa',
]);

export type PaletaConvite = z.infer<typeof PaletaConviteSchema>;
