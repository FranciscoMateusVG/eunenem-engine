import { z } from 'zod/v4';

export const ModeloConviteSchema = z.enum([
  'scrapbook',
  'varal-de-mimos',
  'balao-de-ar',
  'jardim-romantico',
  'lavanda',
  'floresta-magica',
  'roupinhas-e-coracoes',
  'berco-floral',
  'arco-iris-boho',
  'margaridas',
  'girafinha-bailarina',
  'safari',
  'elefantinho',
]);

export type ModeloConvite = z.infer<typeof ModeloConviteSchema>;
