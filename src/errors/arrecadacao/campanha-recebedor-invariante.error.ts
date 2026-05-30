import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Quebra do invariante TOGETHER do agregado Campanha: `idRecebedor` e
 * `dadosRecebedor` devem ser ambos nulos OU ambos preenchidos — nunca um
 * sem o outro. O erro é lançado pelo proprio agregado (construtores /
 * projeções) para impedir estados meio-nulos de chegar ao repositório.
 */
export class ArrecadacaoCampanhaRecebedorInvarianteError extends Error {
  public readonly code = 'ARRECADACAO_CAMPANHA_RECEBEDOR_INVARIANTE' as const;

  constructor(public readonly idCampanha: IdCampanha) {
    super(
      `Invariante violado: campanha "${idCampanha}" deve ter idRecebedor e dadosRecebedor ambos nulos ou ambos preenchidos.`,
    );
    this.name = 'ArrecadacaoCampanhaRecebedorInvarianteError';
  }
}
