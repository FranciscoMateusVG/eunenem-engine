import { z } from 'zod/v4';

/**
 * Value object: rudimentary permission enum. Today only `campaign:admin`
 * exists; this is intentionally not a full RBAC. Equality by value.
 *
 * `PERMISSOES_PADRAO` is the default permission set assigned to every new
 * Conta on registration.
 */

export const PermissaoSchema = z.enum(['campaign:admin']);
export type Permissao = z.infer<typeof PermissaoSchema>;

export const PERMISSOES_PADRAO: readonly Permissao[] = ['campaign:admin'];
