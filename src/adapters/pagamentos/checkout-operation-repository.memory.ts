import { randomUUID } from 'node:crypto';
import type {
  CheckoutClaimKind,
  CheckoutOperation,
  CheckoutOperationRepository,
  ClaimCheckoutOperationInput,
  ClaimCheckoutOperationResult,
  CommitCheckoutLocalInput,
  CompleteCheckoutAttemptInput,
  PrepareCheckoutOperationInput,
} from './checkout-operation-repository.js';
import { assertCheckoutOperationInput } from './checkout-operation-repository.js';
import type { PagamentoRepository } from './repository.js';

const STRIPE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export interface CheckoutAttemptFactMemory {
  readonly operationId: string;
  readonly attemptNo: number;
  readonly factKind: 'claim' | 'result';
  readonly fenceToken: string;
  readonly recordedAt: Date;
  readonly claimKind?: CheckoutClaimKind;
  readonly priorState?: CheckoutOperation['state'];
  readonly outcome?: CompleteCheckoutAttemptInput['outcome'];
  readonly diagnostic?: string | null;
  readonly providerRef?: string | null;
}

export class CheckoutOperationRepositoryMemory implements CheckoutOperationRepository {
  private readonly operations = new Map<string, CheckoutOperation>();
  private readonly facts: CheckoutAttemptFactMemory[] = [];

  constructor(private readonly pagamentos: PagamentoRepository) {}

  async prepare(
    input: PrepareCheckoutOperationInput,
  ): Promise<{ readonly created: boolean; readonly operation: CheckoutOperation }> {
    assertCheckoutOperationInput(input);
    const existing = this.operations.get(input.operationId);
    if (existing) return { created: false, operation: existing };

    await this.pagamentos.save(input.pagamento);
    const operation: CheckoutOperation = {
      operationId: input.operationId,
      platformId: input.platformId,
      campaignId: input.campaignId,
      paymentId: input.pagamento.id,
      provider: input.provider,
      method: input.method,
      capabilityHash: input.capabilityHash,
      requestHmac: input.requestHmac,
      snapshot: input.snapshot,
      state: 'reserved',
      attemptCount: 0,
      leaseToken: null,
      leaseUntil: null,
      providerStartedAt: null,
      providerSucceededAt: null,
      providerRef: null,
      providerExpiresAt: null,
      localCommittedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.operations.set(input.operationId, operation);
    return { created: true, operation };
  }

  async findById(operationId: string): Promise<CheckoutOperation | undefined> {
    return this.operations.get(operationId);
  }

  async claim(input: ClaimCheckoutOperationInput): Promise<ClaimCheckoutOperationResult> {
    const operation = this.operations.get(input.operationId);
    if (
      !operation ||
      operation.capabilityHash !== input.capabilityHash ||
      operation.requestHmac !== input.requestHmac
    ) {
      throw new Error('checkout operation authorization mismatch');
    }
    if (operation.state === 'local_committed') return { status: 'local_committed', operation };
    if (operation.state === 'failed') return { status: 'failed', operation };
    if (
      operation.state === 'in_flight' &&
      operation.leaseUntil !== null &&
      operation.leaseUntil.getTime() > input.now.getTime()
    ) {
      return { status: 'busy', operation };
    }

    let claimKind: CheckoutClaimKind;
    if (operation.state === 'reserved') claimKind = 'create';
    else if (operation.providerRef !== null) claimKind = 'retrieve';
    else if (operation.provider === 'inter') claimKind = 'reconcile';
    else if (
      operation.providerStartedAt !== null &&
      input.now.getTime() < operation.providerStartedAt.getTime() + STRIPE_REPLAY_WINDOW_MS
    ) {
      claimKind = 'create';
    } else return { status: 'expired_window', operation };

    const attemptNo = operation.attemptCount + 1;
    const fenceToken = randomUUID();
    const claimed: CheckoutOperation = {
      ...operation,
      state: 'in_flight',
      attemptCount: attemptNo,
      leaseToken: fenceToken,
      leaseUntil: input.leaseUntil,
      providerStartedAt: operation.providerStartedAt ?? input.now,
      updatedAt: input.now,
    };
    this.operations.set(input.operationId, claimed);
    this.facts.push({
      operationId: input.operationId,
      attemptNo,
      factKind: 'claim',
      fenceToken,
      recordedAt: input.now,
      claimKind,
      priorState: operation.state,
    });
    return { status: 'claimed', operation: claimed, claimKind, attemptNo, fenceToken };
  }

  async completeAttempt(input: CompleteCheckoutAttemptInput): Promise<boolean> {
    const operation = this.operations.get(input.operationId);
    if (
      !operation ||
      operation.state !== 'in_flight' ||
      operation.attemptCount !== input.attemptNo ||
      operation.leaseToken !== input.fenceToken
    ) {
      return false;
    }
    if (
      input.outcome === 'provider_succeeded' &&
      (input.providerRef === null ||
        (operation.providerRef !== null && operation.providerRef !== input.providerRef))
    ) {
      throw new Error('checkout provider reference mismatch');
    }
    this.facts.push({
      operationId: input.operationId,
      attemptNo: input.attemptNo,
      factKind: 'result',
      fenceToken: input.fenceToken,
      recordedAt: input.now,
      outcome: input.outcome,
      diagnostic: input.diagnostic,
      providerRef: input.providerRef,
    });
    const succeeded = input.outcome === 'provider_succeeded';
    this.operations.set(input.operationId, {
      ...operation,
      state: input.outcome,
      providerSucceededAt: succeeded
        ? (operation.providerSucceededAt ?? input.now)
        : operation.providerSucceededAt,
      providerRef: succeeded ? (operation.providerRef ?? input.providerRef) : operation.providerRef,
      providerExpiresAt: succeeded
        ? (operation.providerExpiresAt ?? input.providerExpiresAt)
        : operation.providerExpiresAt,
      leaseToken: succeeded ? operation.leaseToken : null,
      leaseUntil: succeeded ? operation.leaseUntil : null,
      updatedAt: input.now,
    });
    return true;
  }

  async commitLocal(input: CommitCheckoutLocalInput): Promise<boolean> {
    const operation = this.operations.get(input.operationId);
    if (
      !operation ||
      operation.state !== 'provider_succeeded' ||
      operation.providerRef !== input.providerRef ||
      operation.leaseToken !== input.fenceToken
    ) {
      return false;
    }
    const pagamento = await this.pagamentos.findById(operation.paymentId as never);
    if (
      !pagamento ||
      (pagamento.intencao.externalRef !== null &&
        pagamento.intencao.externalRef !== input.providerRef)
    ) {
      return false;
    }
    await this.pagamentos.update({
      ...pagamento,
      intencao: {
        ...pagamento.intencao,
        externalRef: pagamento.intencao.externalRef ?? input.providerRef,
        expiraEm: pagamento.intencao.expiraEm ?? input.providerExpiresAt,
      },
      atualizadoEm: input.now,
    });
    this.operations.set(input.operationId, {
      ...operation,
      state: 'local_committed',
      localCommittedAt: operation.localCommittedAt ?? input.now,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: input.now,
    });
    return true;
  }

  listFactsForTests(operationId: string): readonly CheckoutAttemptFactMemory[] {
    return this.facts.filter((fact) => fact.operationId === operationId);
  }
}
