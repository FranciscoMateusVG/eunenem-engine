import { describe, expect, it } from 'vitest';
import { FinancialLedgerRepositoryMemory } from '../../src/adapters/financial-ledger-repository.memory.js';
import type {
  FinancialEntry,
  RegisterApprovedPaymentFinancialEffectsInput,
} from '../../src/domain/financial.js';
import { FinancialInsufficientAvailableBalanceError } from '../../src/errors/financial-insufficient-available-balance.error.js';
import { FinancialInvalidInputError } from '../../src/errors/financial-invalid-input.error.js';
import { FinancialPaymentAlreadyRecordedError } from '../../src/errors/financial-payment-already-recorded.error.js';
import { FinancialPaymentNotApprovedError } from '../../src/errors/financial-payment-not-approved.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { getPlatformRevenue } from '../../src/use-cases/get-platform-revenue.js';
import { getReceiverFinancialBalance } from '../../src/use-cases/get-receiver-financial-balance.js';
import { registerApprovedPaymentFinancialEffects } from '../../src/use-cases/register-approved-payment-financial-effects.js';
import { requestReceiverPayout } from '../../src/use-cases/request-receiver-payout.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const paymentId = '550e8400-e29b-41d4-a716-446655443001';
const contributionId = '550e8400-e29b-41d4-a716-446655443002';
const receiverId = '550e8400-e29b-41d4-a716-446655443003';
const payoutId = '550e8400-e29b-41d4-a716-446655443004';

function makeApprovedPaymentInput(
  overrides: Partial<RegisterApprovedPaymentFinancialEffectsInput> = {},
): RegisterApprovedPaymentFinancialEffectsInput {
  return {
    paymentId,
    contributionId,
    receiverId,
    paymentStatus: 'approved',
    valueComposition: {
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      feePayer: 'contributor',
    },
    ...overrides,
  };
}

describe('financial use cases', () => {
  it('registers financial effects for the canonical approved payment flow', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();

    const entries = await registerApprovedPaymentFinancialEffects(
      { financialLedgerRepository, clock, observability: silentObservability },
      makeApprovedPaymentInput(),
    );
    const receiverBalance = await getReceiverFinancialBalance(
      { financialLedgerRepository, observability: silentObservability },
      { receiverId },
    );
    const platformRevenue = await getPlatformRevenue({
      financialLedgerRepository,
      observability: silentObservability,
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.type)).toEqual([
      'receiver_balance_credit',
      'platform_revenue_credit',
    ]);
    expect(receiverBalance).toEqual({
      receiverId,
      pendingAmountCents: 8000,
      availableAmountCents: 0,
    });
    expect(platformRevenue).toEqual({ totalAmountCents: 400 });
  });

  it('does not register financial effects twice for the same payment', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();
    const deps = { financialLedgerRepository, clock, observability: silentObservability };

    await registerApprovedPaymentFinancialEffects(deps, makeApprovedPaymentInput());

    await expect(
      registerApprovedPaymentFinancialEffects(deps, makeApprovedPaymentInput()),
    ).rejects.toThrow(FinancialPaymentAlreadyRecordedError);
  });

  it('does not register financial effects for a non-approved payment', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();

    await expect(
      registerApprovedPaymentFinancialEffects(
        { financialLedgerRepository, clock, observability: silentObservability },
        makeApprovedPaymentInput({ paymentStatus: 'rejected' }),
      ),
    ).rejects.toThrow(FinancialPaymentNotApprovedError);
  });

  it('rejects inconsistent value composition as invalid financial input', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();

    await expect(
      registerApprovedPaymentFinancialEffects(
        { financialLedgerRepository, clock, observability: silentObservability },
        makeApprovedPaymentInput({
          valueComposition: {
            contributionAmountCents: 8000,
            feeAmountCents: 400,
            totalPaidCents: 8300,
            receiverAmountCents: 8000,
            feePayer: 'contributor',
          },
        }),
      ),
    ).rejects.toThrow(FinancialInvalidInputError);
  });

  it('creates an initial payout request when the receiver has available balance', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();
    const availableEntry: FinancialEntry = {
      id: '550e8400-e29b-41d4-a716-446655443005',
      paymentId: '550e8400-e29b-41d4-a716-446655443006',
      contributionId: '550e8400-e29b-41d4-a716-446655443007',
      receiverId,
      type: 'receiver_balance_credit',
      amountCents: 5000,
      status: 'available',
      createdAt: fixedDate,
    };
    await financialLedgerRepository.saveEntries([availableEntry]);

    const payout = await requestReceiverPayout(
      { financialLedgerRepository, clock, observability: silentObservability },
      {
        payoutId,
        receiverId,
        amountCents: 3000,
      },
    );

    expect(payout).toEqual({
      id: payoutId,
      receiverId,
      amountCents: 3000,
      status: 'requested',
      requestedAt: fixedDate,
    });
    expect(await financialLedgerRepository.findPayoutRequestById(payoutId)).toEqual(payout);
  });

  it('does not create a payout request above the available balance', async () => {
    const financialLedgerRepository = new FinancialLedgerRepositoryMemory();

    await expect(
      requestReceiverPayout(
        { financialLedgerRepository, clock, observability: silentObservability },
        {
          payoutId,
          receiverId,
          amountCents: 3000,
        },
      ),
    ).rejects.toThrow(FinancialInsufficientAvailableBalanceError);
  });
});
