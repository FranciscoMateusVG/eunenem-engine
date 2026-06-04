import { z } from 'zod/v4';

/**
 * Value object: whether the event is in-person or online.
 */

export const ModalidadeEventoSchema = z.enum(['presencial', 'online']);
export type ModalidadeEvento = z.infer<typeof ModalidadeEventoSchema>;
