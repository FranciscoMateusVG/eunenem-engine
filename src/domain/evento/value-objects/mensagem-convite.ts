import { z } from 'zod/v4';

/**
 * aperture-xipsr — friendly PT-BR default applied when the convite message is
 * left empty. Saving the convite must never hard-fail on an empty message
 * (Thacy hit a raw Zod `too_small` error leaking to the UI at step 5/5); an
 * empty message defaults to this instead so the save always succeeds with a
 * warm, sensible message.
 */
export const MENSAGEM_CONVITE_PADRAO = 'Vai ser muito especial ter você com a gente ♡';

export const MensagemConviteSchema = z
  .string()
  .trim()
  // Length ceiling validates the USER's input first (a real over-long message
  // still errors); the default (well under the cap) always passes.
  .max(2000, 'Mensagem do convite e longa demais')
  // Empty → friendly default. No `min(1)`: an empty message is defaulted, never
  // rejected, so the convite save never hard-fails on emptiness (aperture-xipsr).
  .transform((valor) => (valor.length === 0 ? MENSAGEM_CONVITE_PADRAO : valor));

export type MensagemConvite = z.infer<typeof MensagemConviteSchema>;
