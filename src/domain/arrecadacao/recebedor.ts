import type { DadosRecebedor } from './dados-recebedor.js';
import type { IdCampanha, IdRecebedor } from './ids.js';

export { type IdRecebedor, IdRecebedorSchema } from './ids.js';

/** Recebedor com dados PIX auditáveis; um recebedor ativo por `idCampanha`. */
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
