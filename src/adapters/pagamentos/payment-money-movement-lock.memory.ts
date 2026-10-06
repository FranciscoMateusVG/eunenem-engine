import { FinanceiroPagamentoMovimentacaoConflitanteError } from '../../errors/pagamentos/financeiro/pagamento-movimentacao-conflitante.error.js';
import { sortUniquePaymentIds } from './payment-money-movement-lock.js';

type BlockerProbe = (idPagamento: string) => boolean;

/**
 * Shared in-memory mirror of the PostgreSQL per-payment advisory lock.
 * Finance + refund repositories must receive the same coordinator instance.
 */
export class PaymentMoneyMovementMemoryCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly financialBlockerProbes = new Set<BlockerProbe>();
  private readonly refundBlockerProbes = new Set<BlockerProbe>();

  registerFinancialBlockerProbe(probe: BlockerProbe): void {
    this.financialBlockerProbes.add(probe);
  }

  registerRefundBlockerProbe(probe: BlockerProbe): void {
    this.refundBlockerProbes.add(probe);
  }

  hasBlockingRefund(idPagamento: string): boolean {
    return [...this.refundBlockerProbes].some((probe) => probe(idPagamento));
  }

  async withRefundCreationLock<T>(
    idPagamento: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return this.withPaymentLocks([idPagamento], async () => {
      if ([...this.financialBlockerProbes].some((probe) => probe(idPagamento))) {
        throw new FinanceiroPagamentoMovimentacaoConflitanteError(idPagamento, 'devolucao');
      }
      return operation();
    });
  }

  async withTransferLocks<T>(
    idsPagamento: readonly string[],
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return this.withPaymentLocks(idsPagamento, async () => {
      const blocked = idsPagamento.find((idPagamento) => this.hasBlockingRefund(idPagamento));
      if (blocked !== undefined) {
        throw new FinanceiroPagamentoMovimentacaoConflitanteError(blocked, 'transferencia');
      }
      return operation();
    });
  }

  private async withPaymentLocks<T>(
    idsPagamento: readonly string[],
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    for (const idPagamento of sortUniquePaymentIds(idsPagamento)) {
      const previous = this.tails.get(idPagamento) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      this.tails.set(idPagamento, tail);
      await previous;
      releases.push(() => {
        release();
        if (this.tails.get(idPagamento) === tail) this.tails.delete(idPagamento);
      });
    }
    try {
      return await operation();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}
