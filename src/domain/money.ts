import { z } from 'zod/v4';

/**
 * Montante em centavos (unidade mínima), inteiro positivo.
 * Convenção didática para BRL e evitar erros de ponto flutuante em `number` em reais.
 */
export const MoneyCentsSchema = z.number().int().positive();
export type MoneyCents = z.infer<typeof MoneyCentsSchema>;
