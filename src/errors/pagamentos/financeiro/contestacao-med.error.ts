export class FinanceiroContestacaoMedError extends Error {
  readonly code = 'FINANCEIRO_CONTESTACAO_MED';
  constructor(readonly idPagamento: string) {
    super(
      `Repasse bloqueado por contestação PIX (MED) no pagamento ${idPagamento}. Libere a contestação ou cancele e solicite um novo repasse sem esse pagamento.`,
    );
    this.name = 'FinanceiroContestacaoMedError';
  }
}
