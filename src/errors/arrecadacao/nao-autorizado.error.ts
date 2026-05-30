/**
 * Cross-tenant access in Arrecadação (aperture-d6atj). Levantado quando a
 * use-case detecta que o caller (resolvido por sessão na camada HTTP) tenta
 * atuar sobre um agregado que NÃO pertence à campanha do caller.
 *
 * O adapter HTTP (tRPC contribuicao-router) mapeia para `UNAUTHORIZED` — não
 * `NOT_FOUND` — para manter consistência com o resto do registro de erros
 * de domínio (existence-leak já não é evitado pelos outros erros, e o
 * convention nesse repo é "domain error é honesto, camada HTTP decide
 * mensagem").
 */
export class ArrecadacaoNaoAutorizadoError extends Error {
  public readonly code = 'ARRECADACAO_NAO_AUTORIZADO' as const;

  constructor(public readonly reason: string) {
    super(`Operacao nao autorizada na arrecadacao: ${reason}`);
    this.name = 'ArrecadacaoNaoAutorizadoError';
  }
}
