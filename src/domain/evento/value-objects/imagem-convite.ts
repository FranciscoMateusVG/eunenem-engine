import { z } from 'zod/v4';

const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g)(?:[?#].*)?$/i;

export const ImagemConviteSchema = z
  .string()
  .trim()
  .min(1, 'Imagem do convite nao pode ser vazia')
  .max(500, 'Imagem do convite e longa demais')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Imagem do convite deve ser uma URL valida')
  .refine(
    (value) => IMAGE_FILE_EXTENSION_REGEX.test(value),
    'Imagem do convite deve apontar para um arquivo PNG, JPG ou JPEG',
  );

export type ImagemConvite = z.infer<typeof ImagemConviteSchema>;
