import { describe, expect, it } from 'vitest';
import {
  calculatePlatformRevenue,
  calculateReceiverFinancialBalance,
  createFinancialEntriesForApprovedPayment,
  createRequestedReceiverPayout,
  type FinancialEntry,
  type RegisterApprovedPaymentFinancialEffectsInput,
} from '../../src/domain/financial.js';

const paymentId = '550e8400-e29b-41d4-a716-446655441001';
const contributionId = '550e8400-e29b-41d4-a716-446655441002';
const receiverId = '550e8400-e29b-41d4-a716-446655441003';
const receiverEntryId = '550e8400-e29b-41d4-a716-446655441004';
const platformRevenueEntryId = '550e8400-e29b-41d4-a716-446655441005';
const payoutId = '550e8400-e29b-41d4-a716-446655441006';
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

describe('createFinancialEntriesForApprovedPayment', () => {
  it('creates receiver balance and platform revenue entries for the canonical flow', () => {
    const entries = createFinancialEntriesForApprovedPayment(
      approvedPaymentInput,
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    );

    expect(entries).toEqual([
      {
        id: receiverEntryId,
        paymentId,
        contributionId,
        receiverId,
        type: 'receiver_balance_credit',
        amountCents: 8000,
        status: 'pending',
        createdAt,
      },
      {
        id: platformRevenueEntryId,
        paymentId,
        contributionId,
        type: 'platform_revenue_credit',
        amountCents: 400,
        status: 'available',
        createdAt,
      },
    ]);
  });

  it('rejects payments that are not approved', () => {
    expect(() =>
      createFinancialEntriesForApprovedPayment(
        { ...approvedPaymentInput, paymentStatus: 'pending' },
        { receiverEntryId, platformRevenueEntryId },
        createdAt,
      ),
    ).toThrow('Only approved payments can generate financial entries.');
  });

  it('rejects an inconsistent value composition', () => {
    expect(() =>
      createFinancialEntriesForApprovedPayment(
        {
          ...approvedPaymentInput,
          valueComposition: {
            ...approvedPaymentInput.valueComposition,
            totalPaidCents: 8300,
          },
        },
        { receiverEntryId, platformRevenueEntryId },
        createdAt,
      ),
    ).toThrow('Financial value composition does not match total paid amount.');
  });

  it('uses the received fee amount without recalculating it', () => {
    const entries = createFinancialEntriesForApprovedPayment(
      {
        ...approvedPaymentInput,
        valueComposition: {
          contributionAmountCents: 8000,
          feeAmountCents: 500,
          totalPaidCents: 8500,
          receiverAmountCents: 8000,
          feePayer: 'contributor',
        },
      },
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    );

    expect(entries[1].amountCents).toBe(500);
  });
});

describe('financial summaries', () => {
  it('separates pending and available receiver balance', () => {
    const pendingEntry = createFinancialEntriesForApprovedPayment(
      approvedPaymentInput,
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    )[0];
    const availableEntry: FinancialEntry = {
      ...pendingEntry,
      id: '550e8400-e29b-41d4-a716-446655441007',
      paymentId: '550e8400-e29b-41d4-a716-446655441008',
      status: 'available',
      amountCents: 2000,
    };

    expect(calculateReceiverFinancialBalance(receiverId, [pendingEntry, availableEntry])).toEqual({
      receiverId,
      pendingAmountCents: 8000,
      availableAmountCents: 2000,
    });
  });

  it('accumulates only platform revenue entries', () => {
    const entries = createFinancialEntriesForApprovedPayment(
      approvedPaymentInput,
      { receiverEntryId, platformRevenueEntryId },
      createdAt,
    );

    expect(calculatePlatformRevenue(entries)).toEqual({ totalAmountCents: 400 });
  });
});

describe('createRequestedReceiverPayout', () => {
  it('creates a payout request in the initial requested status', () => {
    expect(
      createRequestedReceiverPayout(
        {
          payoutId,
          receiverId,
          amountCents: 2000,
        },
        createdAt,
      ),
    ).toEqual({
      id: payoutId,
      receiverId,
      amountCents: 2000,
      status: 'requested',
      requestedAt: createdAt,
    });
  });
});
