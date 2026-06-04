import { z } from 'zod/v4';

export const StatusPresencaConvidadoSchema = z.enum(['sim', 'nao', 'talvez']);

export type StatusPresencaConvidado = z.infer<typeof StatusPresencaConvidadoSchema>;
