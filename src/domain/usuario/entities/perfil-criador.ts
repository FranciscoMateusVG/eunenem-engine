import type { ConteudoPerfilCriador } from '../value-objects/conteudo-perfil-criador.js';
import type { IdPerfilCriador, IdUsuario } from '../value-objects/ids.js';

/**
 * @aggregateRoot PerfilCriador (BC Usuário)
 *
 * The creator's public-profile record — 1:1 with `Usuario` (aperture-3dlzs).
 * Modeled as a SEPARATE aggregate (same pattern as Arrecadação's Recebedor)
 * so the identity-only `Usuario` root stays free of presentation fields
 * (babyName, story, photos, event dates). One profile per Usuario, enforced
 * by a UNIQUE constraint on `id_usuario` at the persistence layer.
 *
 * Holds only the editable profile CONTENT (`ConteudoPerfilCriador`) plus its
 * own identity and timestamps. The profile slug stays on `Usuario.slug`
 * (R2), and receiving/Pix data stays out of scope here (R4).
 *
 * Persisted via: `PerfilCriadorRepository`.
 */
export interface PerfilCriador {
  readonly id: IdPerfilCriador;
  readonly idUsuario: IdUsuario;
  readonly conteudo: ConteudoPerfilCriador;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarPerfilCriadorInput {
  readonly id: IdPerfilCriador;
  readonly idUsuario: IdUsuario;
  readonly conteudo: ConteudoPerfilCriador;
  readonly criadoEm: Date;
}

/** Cria um novo perfil de criador (atualizadoEm = criadoEm no início). */
export function criarPerfilCriador(input: CriarPerfilCriadorInput): PerfilCriador {
  return {
    id: input.id,
    idUsuario: input.idUsuario,
    conteudo: input.conteudo,
    criadoEm: input.criadoEm,
    atualizadoEm: input.criadoEm,
  };
}

export interface AtualizarConteudoPerfilCriadorInput {
  readonly conteudo: ConteudoPerfilCriador;
  readonly atualizadoEm: Date;
}

/** Substitui o conteúdo do perfil e carimba atualizadoEm (identidade preservada). */
export function atualizarConteudoPerfilCriador(
  perfil: PerfilCriador,
  input: AtualizarConteudoPerfilCriadorInput,
): PerfilCriador {
  return {
    ...perfil,
    conteudo: input.conteudo,
    atualizadoEm: input.atualizadoEm,
  };
}
