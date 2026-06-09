import { z } from 'zod/v4';

const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g)(?:[?#].*)?$/i;

export const ImagemUrlConviteSchema = z
  .string()
  .trim()
  .min(1, 'Imagem URL do convite nao pode ser vazia')
  .max(500, 'Imagem URL do convite e longa demais')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Imagem URL do convite deve ser uma URL valida')
  .refine(
    (value) => IMAGE_FILE_EXTENSION_REGEX.test(value),
    'Imagem URL do convite deve apontar para um arquivo PNG, JPG ou JPEG',
  );

export type ImagemUrlConvite = z.infer<typeof ImagemUrlConviteSchema>;
