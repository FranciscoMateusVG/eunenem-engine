import { z } from 'zod/v4';

/**
 * `nao_enviado` — convite ainda nao foi enviado ao convidado.
 * `enviado` — mensagem de convite enviada, aguardando resposta do convidado.
 */
export const StatusPresencaConvidadoSchema = z.enum([
  'nao_enviado',
  'enviado',
  'sim',
  'nao',
  'talvez',
]);

export type StatusPresencaConvidado = z.infer<typeof StatusPresencaConvidadoSchema>;
