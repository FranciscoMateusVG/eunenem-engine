import { z } from 'zod/v4';

export const FormatoMensagemConviteSchema = z.enum(['convite_virtual', 'texto']);

export type FormatoMensagemConvite = z.infer<typeof FormatoMensagemConviteSchema>;
