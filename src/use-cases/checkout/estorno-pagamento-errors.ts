export class PagamentoEstornoLancamentoJaTransferidoError extends Error {
  constructor(public readonly idPagamento: string) {
    super(
      `Estorno bloqueado: pelo menos um lancamento financeiro deste pagamento ja foi transferido ao recebedor. idPagamento=${idPagamento}`,
    );
    this.name = 'PagamentoEstornoLancamentoJaTransferidoError';
  }
}

export class PagamentoEstornoRecusadoPeloProvedorError extends Error {
  constructor(
    public readonly idPagamento: string,
    public readonly statusBruto: string | undefined,
  ) {
    super(
      `Provedor recusou o estorno do pagamento ${idPagamento} (status bruto: ${statusBruto ?? 'desconhecido'}).`,
    );
    this.name = 'PagamentoEstornoRecusadoPeloProvedorError';
  }
}

export class PagamentoEstornoPixNaoConcluidoError extends Error {
  constructor(
    public readonly idPagamento: string,
    public readonly status: 'nao_realizada' | 'rejeitada',
  ) {
    // Banco Inter's free-form motivo/codigo is deliberately excluded. It is
    // provider-controlled data and does not belong in user-facing errors or
    // logs. The categorical lifecycle is sufficient for callers.
    super(`Devolucao PIX nao concluida para o pagamento ${idPagamento}: ${status}.`);
    this.name = 'PagamentoEstornoPixNaoConcluidoError';
  }
}

export class PagamentoEstornoPixVinculoInvalidoError extends Error {
  constructor() {
    super('Identidade de devolucao PIX nao corresponde ao pagamento persistido.');
    this.name = 'PagamentoEstornoPixVinculoInvalidoError';
  }
}
