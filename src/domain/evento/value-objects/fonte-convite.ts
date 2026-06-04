import { z } from 'zod/v4';

export const FonteConviteSchema = z.enum(['patrick', 'caveat']);

export type FonteConvite = z.infer<typeof FonteConviteSchema>;
