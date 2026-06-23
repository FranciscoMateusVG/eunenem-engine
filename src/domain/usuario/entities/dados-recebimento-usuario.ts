import type { DadosRecebedor } from '../../arrecadacao/value-objects/dados-recebedor.js';
import type { IdUsuario } from '../value-objects/ids.js';

/**
 * @aggregateRoot DadosRecebimentoUsuario (BC Usuário) — aperture-mcvyw #4a-i.
 *
 * User-level receiving data, editable in settings BEFORE any campaign exists,
 * then projected onto the active campaign's `Recebedor`. 1:1 with `Usuario`
 * (UNIQUE id_usuario, FK ON DELETE CASCADE) — same parent-link pattern as
 * `PerfilCriador`.
 *
 * REUSES Arrecadação's `DadosRecebedor` discriminated-union VO wholesale
 * (pix | conta). The cross-BC domain import (usuario → arrecadacao) is
 * permitted by dependency-cruiser: both live under `src/domain/` and the
 * `domain-no-external-imports` rule only forbids imports OUTSIDE
 * `src/domain/`.
 *
 * Persisted via: `DadosRecebimentoRepository`.
 */
export interface DadosRecebimentoUsuario {
  readonly idUsuario: IdUsuario;
  readonly dados: DadosRecebedor;
  readonly atualizadoEm: Date;
}

export interface CriarDadosRecebimentoUsuarioInput {
  readonly idUsuario: IdUsuario;
  readonly dados: DadosRecebedor;
  readonly atualizadoEm: Date;
}

/** Cria o registro de dados de recebimento do usuário. */
export function criarDadosRecebimentoUsuario(
  input: CriarDadosRecebimentoUsuarioInput,
): DadosRecebimentoUsuario {
  return {
    idUsuario: input.idUsuario,
    dados: input.dados,
    atualizadoEm: input.atualizadoEm,
  };
}

export interface AtualizarDadosRecebimentoUsuarioInput {
  readonly dados: DadosRecebedor;
  readonly atualizadoEm: Date;
}

/** Substitui os dados de recebimento e carimba atualizadoEm (idUsuario preservado). */
export function atualizarDadosRecebimentoUsuario(
  registro: DadosRecebimentoUsuario,
  input: AtualizarDadosRecebimentoUsuarioInput,
): DadosRecebimentoUsuario {
  return {
    ...registro,
    dados: input.dados,
    atualizadoEm: input.atualizadoEm,
  };
}
