import type { DadosRecebedor } from '../value-objects/dados-recebedor.js';
import type { IdCampanha, IdRecebedor } from '../value-objects/ids.js';

/**
 * @aggregateRoot Recebedor (BC Arrecadação)
 *
 * Auditable PIX-receiver record bound to a Campanha. Versioned: when the
 * `DadosRecebedor` change, the active row is deactivated and a new one is
 * created — full history is preserved (`is_active` per campanha).
 *
 * Persisted via: `RecebedorRepository`.
 *
 * Aggregate boundary: deactivation + new-active-row creation happen as a unit
 * (orchestrated by the use case via the transaction port).
 */
export interface Recebedor {
  readonly id: IdRecebedor;
  readonly idCampanha: IdCampanha;
  readonly dadosRecebedor: DadosRecebedor;
  readonly isActive: boolean;
  readonly criadaEm: Date;
}

export interface CriarRecebedorInicialInput {
  readonly id: IdRecebedor;
  readonly idCampanha: IdCampanha;
  readonly dadosRecebedor: DadosRecebedor;
  readonly criadaEm: Date;
}

export function criarRecebedorInicial(input: CriarRecebedorInicialInput): Recebedor {
  return {
    id: input.id,
    idCampanha: input.idCampanha,
    dadosRecebedor: input.dadosRecebedor,
    isActive: true,
    criadaEm: input.criadaEm,
  };
}

/** Marca o recebedor como inativo (histórico preservado). */
export function desativarRecebedor(recebedor: Recebedor): Recebedor {
  return {
    ...recebedor,
    isActive: false,
  };
}

export interface CriarNovoRecebedorInput {
  readonly idCampanha: IdCampanha;
  readonly dadosRecebedor: DadosRecebedor;
  readonly gerarId: () => IdRecebedor;
  readonly criadaEm: Date;
}

/** Novo recebedor ativo para a mesma campanha. */
export function criarNovoRecebedor(input: CriarNovoRecebedorInput): Recebedor {
  return {
    id: input.gerarId(),
    idCampanha: input.idCampanha,
    dadosRecebedor: input.dadosRecebedor,
    isActive: true,
    criadaEm: input.criadaEm,
  };
}
