import { z } from 'zod/v4';

/**
 * Identifier value objects for the Usuário BC.
 *
 * `IdContaUsuario` is the same UUID type that Arrecadação's `IdConta` carries
 * — kept BC-local so Usuário does not depend on Arrecadação's domain types.
 * Application-level orchestration glues them by passing the same UUID through.
 */

export const IdUsuarioSchema = z.uuid();
export type IdUsuario = z.infer<typeof IdUsuarioSchema>;

export const IdContaUsuarioSchema = z.uuid();
export type IdContaUsuario = z.infer<typeof IdContaUsuarioSchema>;

/**
 * Identity of the `PerfilCriador` aggregate (aperture-3dlzs). Own UUID,
 * distinct from `IdUsuario` — the profile is 1:1 with a Usuario but is a
 * separate aggregate root (same pattern as Arrecadação's Recebedor) so the
 * identity-only Usuario root stays free of presentation fields.
 */
export const IdPerfilCriadorSchema = z.uuid();
export type IdPerfilCriador = z.infer<typeof IdPerfilCriadorSchema>;

/**
 * Mirror VO: a public reference to a Plataforma. Same shape as the BC's own
 * IdPlataforma, but defined locally so Usuário does NOT import from
 * `src/domain/plataforma/`. Enforced by dependency-cruiser.
 */
export const IdPlataformaReferenciaSchema = z.uuid();
export type IdPlataformaReferencia = z.infer<typeof IdPlataformaReferenciaSchema>;
