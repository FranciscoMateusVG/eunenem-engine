import type { ConteudoPerfilCriador } from '../../usuario/value-objects/conteudo-perfil-criador.js';
import type { IdCampanha, IdPerfilCampanha } from '../value-objects/ids.js';

/**
 * @aggregateRoot PerfilCampanha (BC Arrecadação)
 *
 * The per-campanha profile record (aperture-aphk8, W1a) — 1:1 with `Campanha`.
 * Mirrors Usuário's `PerfilCriador` (1:1 with Usuario) but keyed to the
 * campanha, so a conta with multiple listas can present a different baby per
 * lista. One profile per Campanha, enforced by a UNIQUE constraint on
 * `id_campanha` at the persistence layer.
 *
 * Content REUSES the `ConteudoPerfilCriador` VO verbatim (cross-BC VO reuse
 * blessed by the W1 design §1.2): identical fields, identical invariants —
 * the profile content didn't change shape, only its owning key did.
 *
 * Persisted via: `PerfilCampanhaRepository`.
 */
export interface PerfilCampanha {
  readonly id: IdPerfilCampanha;
  readonly idCampanha: IdCampanha;
  readonly conteudo: ConteudoPerfilCriador;
  readonly criadoEm: Date;
  readonly atualizadoEm: Date;
}

export interface CriarPerfilCampanhaInput {
  readonly id: IdPerfilCampanha;
  readonly idCampanha: IdCampanha;
  readonly conteudo: ConteudoPerfilCriador;
  readonly criadoEm: Date;
}

/** Cria um novo perfil de campanha (atualizadoEm = criadoEm no início). */
export function criarPerfilCampanha(input: CriarPerfilCampanhaInput): PerfilCampanha {
  return {
    id: input.id,
    idCampanha: input.idCampanha,
    conteudo: input.conteudo,
    criadoEm: input.criadoEm,
    atualizadoEm: input.criadoEm,
  };
}

export interface AtualizarConteudoPerfilCampanhaInput {
  readonly conteudo: ConteudoPerfilCriador;
  readonly atualizadoEm: Date;
}

/** Substitui o conteúdo do perfil e carimba atualizadoEm (identidade preservada). */
export function atualizarConteudoPerfilCampanha(
  perfil: PerfilCampanha,
  input: AtualizarConteudoPerfilCampanhaInput,
): PerfilCampanha {
  return {
    ...perfil,
    conteudo: input.conteudo,
    atualizadoEm: input.atualizadoEm,
  };
}
