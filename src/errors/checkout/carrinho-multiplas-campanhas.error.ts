/**
 * Plan 0016 (aperture-eg1s2): user-facing error when a cart contains
 * items from more than one campanha. Cart-scope invariant per locked
 * decision #8 — all items in one IntencaoPagamento share the same
 * idCampanha; the saga rejects construction with this error at the API
 * boundary; the IntencaoPagamento factory is the honest backstop and
 * throws a plain Error (programming-bug surface) if reached with
 * mismatched campanhas.
 *
 * Maps to HTTP 400 at the eunenem-server tRPC boundary (same shape as
 * `ArrecadacaoContribuicaoIndisponivelError` — a clean user-facing
 * failure that's a UX disclaimer, not a runtime panic).
 */
export class CarrinhoMultiplasCampanhasError extends Error {
  readonly name = 'CarrinhoMultiplasCampanhasError';
  readonly idsCampanhas: readonly string[];

  constructor(idsCampanhas: readonly string[]) {
    super(
      `Carrinho contém itens de múltiplas campanhas (${idsCampanhas.join(', ')}). Um pagamento só pode conter contribuições de uma única campanha.`,
    );
    this.idsCampanhas = idsCampanhas;
  }
}
