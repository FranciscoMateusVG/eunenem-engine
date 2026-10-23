import type { IdContaUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { PendenciaDesativacao } from '../../domain/usuario/value-objects/pendencia-desativacao.js';

export type { PendenciaDesativacao };

export interface PendenciasDesativacaoRepository {
  /** Pendências financeiras nas campanhas em que a conta é owner. */
  listarPendencias(idConta: IdContaUsuario): Promise<readonly PendenciaDesativacao[]>;
}
