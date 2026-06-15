import { z } from 'zod/v4';

export const FonteConviteSchema = z.enum([
  'patrick',
  'caveat',
  'dancing-script',
  'shadows-into-light',
  'handlee',
]);

export type FonteConvite = z.infer<typeof FonteConviteSchema>;
