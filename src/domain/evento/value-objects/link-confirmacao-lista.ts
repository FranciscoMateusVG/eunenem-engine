import { z } from 'zod/v4';

export const LinkConfirmacaoSchema = z.string().trim().url('Link de confirmacao invalido');

export type LinkConfirmacao = z.infer<typeof LinkConfirmacaoSchema>;
