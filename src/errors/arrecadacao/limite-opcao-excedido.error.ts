import type {
  IdCampanha,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Raised when `criarContribuicao` would push an opção past
 * `LIMITE_CONTRIBUICOES_POR_OPCAO`. The cap is a deliberate scale guardrail —
 * see `src/domain/arrecadacao/entities/contribuicao.ts` for the rationale.
 */
export class ArrecadacaoLimiteOpcaoExcedidoError extends Error {
  public readonly code = 'ARRECADACAO_LIMITE_OPCAO_EXCEDIDO' as const;

  constructor(
    public readonly idCampanha: IdCampanha,
    public readonly idOpcao: IdOpcaoContribuicao,
    public readonly limite: number,
    public readonly atual: number,
  ) {
    super(
      `Opcao "${idOpcao}" da campanha "${idCampanha}" ja possui ${atual} contribuicoes, atingindo o limite de ${limite}.`,
    );
    this.name = 'ArrecadacaoLimiteOpcaoExcedidoError';
  }
}
