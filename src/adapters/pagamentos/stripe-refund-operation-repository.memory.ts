import { estornarPagamentoAprovado } from '../../domain/pagamentos/entities/pagamento.js';
import type { LivroFinanceiroRepository } from './financeiro/livro-repository.js';
import { PaymentMoneyMovementMemoryCoordinator } from './payment-money-movement-lock.memory.js';
import type { PagamentoRepository } from './repository.js';
import {
  type ClaimStripeRefundResult,
  type ObserveVerifiedStripeRefundInput,
  type RecordStripeRefundResultInput,
  type ReserveStripeRefundInput,
  type StripeRefundOperation,
  StripeRefundOperationConflictError,
  type StripeRefundOperationRepository,
} from './stripe-refund-operation-repository.js';

function copy(record: StripeRefundOperation): StripeRefundOperation {
  return {
    ...record,
    providerStartedAt: record.providerStartedAt && new Date(record.providerStartedAt),
    providerResultAt: record.providerResultAt && new Date(record.providerResultAt),
    localCommittedAt: record.localCommittedAt && new Date(record.localCommittedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

export class StripeRefundOperationRepositoryMemory implements StripeRefundOperationRepository {
  private readonly byPayment = new Map<string, StripeRefundOperation>();
  private readonly events = new Map<string, string>();

  constructor(
    private readonly payments: PagamentoRepository,
    private readonly ledger: LivroFinanceiroRepository,
    private readonly moneyMovement = new PaymentMoneyMovementMemoryCoordinator(),
  ) {
    this.moneyMovement.registerRefundBlockerProbe((paymentId) => {
      const row = this.byPayment.get(paymentId);
      return row !== undefined && row.state !== 'provider_failed';
    });
  }

  async reserve(input: ReserveStripeRefundInput) {
    return this.moneyMovement.withRefundCreationLock(input.paymentId, async () => {
      const payment = await this.payments.findById(input.paymentId);
      if (
        !payment ||
        payment.status !== 'aprovado' ||
        payment.transacaoExterna?.provedor !== 'stripe' ||
        payment.transacaoExterna.status !== 'aprovado' ||
        payment.transacaoExterna.amountCents !== input.amountCents ||
        (payment.transacaoExterna.id !== input.chargeRef &&
          payment.transacaoExterna.id !== input.paymentIntentRef) ||
        payment.intencao.composicaoValoresAggregate.totalPaidCents !== input.amountCents ||
        payment.intencao.chargeExternalRef !== input.chargeRef ||
        payment.intencao.paymentIntentExternalRef !== input.paymentIntentRef
      ) {
        throw new StripeRefundOperationConflictError();
      }
      const existing = this.byPayment.get(input.paymentId);
      if (existing) {
        if (
          existing.amountCents !== input.amountCents ||
          existing.currency !== input.currency ||
          existing.chargeRef !== input.chargeRef ||
          existing.paymentIntentRef !== input.paymentIntentRef ||
          existing.reason !== input.reason
        ) {
          throw new StripeRefundOperationConflictError();
        }
        return { created: false, operation: copy(existing) };
      }
      const operation: StripeRefundOperation = {
        operationId: input.operationId,
        paymentId: input.paymentId,
        origin: 'admin',
        amountCents: input.amountCents,
        currency: input.currency,
        chargeRef: input.chargeRef,
        paymentIntentRef: input.paymentIntentRef,
        reason: input.reason,
        state: 'reserved',
        attemptCount: 0,
        providerRef: null,
        providerStatus: null,
        providerStartedAt: null,
        providerResultAt: null,
        localCommittedAt: null,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      this.byPayment.set(input.paymentId, operation);
      return { created: true, operation: copy(operation) };
    });
  }

  async findByPaymentId(paymentId: StripeRefundOperation['paymentId']) {
    const row = this.byPayment.get(paymentId);
    return row && copy(row);
  }

  async claimProviderStart(operationId: string, now: Date): Promise<ClaimStripeRefundResult> {
    const initial = [...this.byPayment.values()].find((row) => row.operationId === operationId);
    if (!initial) throw new StripeRefundOperationConflictError();
    return this.moneyMovement.withRefundCreationLock(initial.paymentId, () => {
      const row = this.byPayment.get(initial.paymentId);
      if (!row || row.operationId !== operationId) throw new StripeRefundOperationConflictError();
      if (row.state !== 'reserved' && row.state !== 'provider_failed') {
        return {
          status: row.state as Exclude<ClaimStripeRefundResult['status'], 'call_provider'>,
          operation: copy(row),
        };
      }
      const attemptNo = row.attemptCount + 1;
      const updated: StripeRefundOperation = {
        ...row,
        state: 'provider_started',
        attemptCount: attemptNo,
        providerRef: null,
        providerStatus: null,
        providerStartedAt: new Date(now),
        providerResultAt: null,
        updatedAt: new Date(now),
      };
      this.byPayment.set(row.paymentId, updated);
      return {
        status: 'call_provider',
        operation: copy(updated),
        attemptNo,
        idempotencyKey: `pagamento:${row.paymentId}:refund:${attemptNo}`,
      };
    });
  }

  async recordProviderResult(input: RecordStripeRefundResultInput) {
    const row = [...this.byPayment.values()].find(
      (value) => value.operationId === input.operationId,
    );
    if (
      !row ||
      row.attemptCount !== input.attemptNo ||
      row.amountCents !== input.amountCents ||
      row.currency !== input.currency
    ) {
      throw new StripeRefundOperationConflictError();
    }
    if (row.state !== 'provider_started') return copy(row);
    const updated: StripeRefundOperation = {
      ...row,
      state: input.outcome,
      providerRef: input.providerRef,
      providerStatus: input.providerStatus,
      providerResultAt: new Date(input.now),
      updatedAt: new Date(input.now),
    };
    this.byPayment.set(row.paymentId, updated);
    return copy(updated);
  }

  async recordOutcomeUnknown(operationId: string, attemptNo: number, now: Date): Promise<void> {
    const row = [...this.byPayment.values()].find((value) => value.operationId === operationId);
    if (!row || row.attemptCount !== attemptNo || row.state !== 'provider_started') return;
    this.byPayment.set(row.paymentId, {
      ...row,
      state: 'outcome_unknown',
      providerStatus: 'unknown',
      updatedAt: new Date(now),
    });
  }

  async convergeSuccessful(operationId: string, now: Date) {
    const row = [...this.byPayment.values()].find((value) => value.operationId === operationId);
    if (!row) throw new StripeRefundOperationConflictError();
    if (row.state === 'local_committed') return { status: 'already_converged' as const };
    if (row.state !== 'provider_succeeded') return { status: 'held_conflict' as const };
    const payment = await this.payments.findById(row.paymentId);
    if (!payment || (payment.status !== 'aprovado' && payment.status !== 'estornado')) {
      return { status: 'held_conflict' as const };
    }
    if (await this.ledger.hasLancamentosTransferidos(row.paymentId)) {
      return { status: 'held_conflict' as const };
    }
    if (payment.status === 'aprovado') {
      await this.payments.update(estornarPagamentoAprovado(payment, now));
    }
    await this.ledger.marcarLancamentosComoCanceladosPorPagamento(row.paymentId, now);
    this.byPayment.set(row.paymentId, {
      ...row,
      state: 'local_committed',
      localCommittedAt: new Date(now),
      updatedAt: new Date(now),
    });
    return {
      status:
        payment.status === 'estornado' ? ('already_converged' as const) : ('converged' as const),
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: mirrors the atomic Postgres observation/conflict/convergence state machine
  async observeVerifiedAndConverge(input: ObserveVerifiedStripeRefundInput) {
    const replayOperation = this.events.get(input.eventId);
    if (replayOperation) {
      const row = [...this.byPayment.values()].find(
        (value) => value.operationId === replayOperation,
      );
      return {
        status:
          row?.state === 'local_committed'
            ? ('already_converged' as const)
            : ('held_conflict' as const),
      };
    }
    const payment = await this.payments.findById(input.paymentId);
    let row = this.byPayment.get(input.paymentId);
    const exact =
      payment !== undefined &&
      (payment.status === 'aprovado' || payment.status === 'estornado') &&
      input.currency === 'brl' &&
      payment.intencao.composicaoValoresAggregate.totalPaidCents === input.amountCents &&
      payment.intencao.chargeExternalRef === input.chargeRef &&
      payment.intencao.paymentIntentExternalRef === input.paymentIntentRef &&
      payment.transacaoExterna?.provedor === 'stripe' &&
      payment.transacaoExterna.status === 'aprovado' &&
      payment.transacaoExterna.amountCents === input.amountCents &&
      (payment.transacaoExterna.id === input.chargeRef ||
        payment.transacaoExterna.id === input.paymentIntentRef) &&
      (!row ||
        (row.amountCents === input.amountCents &&
          row.currency === input.currency &&
          row.chargeRef === input.chargeRef &&
          row.paymentIntentRef === input.paymentIntentRef));
    const financialConflict = payment
      ? await this.ledger.hasLancamentosTransferidos(input.paymentId)
      : true;
    if (!row) {
      row = {
        operationId: input.operationId,
        paymentId: input.paymentId,
        origin: 'webhook',
        amountCents: input.amountCents,
        currency: 'brl',
        chargeRef: input.chargeRef,
        paymentIntentRef: input.paymentIntentRef,
        reason: 'requested_by_customer',
        state: exact && !financialConflict ? 'provider_succeeded' : 'outcome_unknown',
        attemptCount: 0,
        providerRef: null,
        providerStatus: 'succeeded',
        providerStartedAt: null,
        providerResultAt: new Date(input.now),
        localCommittedAt: null,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
    } else {
      row = {
        ...row,
        state: exact && !financialConflict ? 'provider_succeeded' : 'outcome_unknown',
        providerRef: null,
        providerStatus: 'succeeded',
        providerResultAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
    }
    this.byPayment.set(input.paymentId, row);
    this.events.set(input.eventId, row.operationId);
    if (!exact || financialConflict) return { status: 'held_conflict' as const };
    return this.convergeSuccessful(row.operationId, input.now);
  }
}
