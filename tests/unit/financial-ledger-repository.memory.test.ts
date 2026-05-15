import { describe, expect, it } from 'vitest';
import { FinancialLedgerRepositoryMemory } from '../../src/adapters/financial-ledger-repository.memory.js';
import {
  createFinancialEntriesForApprovedPayment,
  createRequestedReceiverPayout,
  type RegisterApprovedPaymentFinancialEffectsInput,
} from '../../src/domain/financial.js';
import { FinancialPaymentAlreadyRecordedError } from '../../src/errors/financial-payment-already-recorded.error.js';

const paymentId = '550e8400-e29b-41d4-a716-446655442001';
const contributionId = '550e8400-e29b-41d4-a716-446655442002';
const receiverId = '550e8400-e29b-41d4-a716-446655442003';
const receiverEntryId = '550e8400-e29b-41d4-a716-446655442004';
const platformRevenueEntryId = '550e8400-e29b-41d4-a716-446655442005';
const payoutId = '550e8400-e29b-41d4-a716-446655442006';
const createdAt = new Date('2026-05-01T12:00:00.000Z');

const approvedPaymentInput: RegisterApprovedPaymentFinancialEffectsInput = {
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
};

describe('FinancialLedgerRepositoryMemory', () => {
  it('saves and lists financial entries by payment, receiver and platform revenue', async () => {
    const repository = new FinancialLedgerRepositoryMemory();
    const entries = createFinancialEntriesForApprovedPayment(
      approvedPaymentInput,
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    );

    await repository.saveEntries(entries);

    expect(await repository.findEntriesByPaymentId(paymentId)).toEqual(entries);
    expect(await repository.findEntriesByReceiverId(receiverId)).toEqual([entries[0]]);
    expect(await repository.findPlatformRevenueEntries()).toEqual([entries[1]]);
  });

  it('does not save duplicate entries for the same payment', async () => {
    const repository = new FinancialLedgerRepositoryMemory();
    const entries = createFinancialEntriesForApprovedPayment(
      approvedPaymentInput,
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    );

    await repository.saveEntries(entries);

    await expect(repository.saveEntries(entries)).rejects.toThrow(
      FinancialPaymentAlreadyRecordedError,
    );
  });

  it('saves and lists payout requests by id and receiver', async () => {
    const repository = new FinancialLedgerRepositoryMemory();
    const payout = createRequestedReceiverPayout(
      {
        payoutId,
        receiverId,
        amountCents: 2000,
      },
      createdAt,
    );

    await repository.savePayoutRequest(payout);

    expect(await repository.findPayoutRequestById(payoutId)).toEqual(payout);
    expect(await repository.findPayoutRequestsByReceiverId(receiverId)).toEqual([payout]);
  });
});
