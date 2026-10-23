import type { PendenciaDesativacao } from '../../domain/usuario/value-objects/pendencia-desativacao.js';

export class ContaComPendenciasFinanceirasError extends Error {
  public readonly code = 'CONTA_COM_PENDENCIAS_FINANCEIRAS' as const;

  constructor(public readonly pendencias: readonly PendenciaDesativacao[]) {
    super(`Conta com pendencias financeiras: ${pendencias.join(', ')}`);
    this.name = 'ContaComPendenciasFinanceirasError';
  }
}
