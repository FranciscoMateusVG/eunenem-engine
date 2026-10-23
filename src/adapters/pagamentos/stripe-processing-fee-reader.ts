import type Stripe from 'stripe';
import type { ProcessingFeeObservation, ProcessingFeeReader } from './processing-fee-reader.js';

/** GET-only, bounded SDK reads. No refunds, captures or money movement here. */
export class StripeProcessingFeeReader implements ProcessingFeeReader {
  private accountRef: string | undefined;
  constructor(private readonly stripe: Stripe) {}
  async read(input: {
    chargeRef: string | null;
    paymentIntentRef: string | null;
  }): Promise<ProcessingFeeObservation | null> {
    const options = { timeout: 10_000, maxNetworkRetries: 0 };
    let charge: Stripe.Charge | null = null;
    if (input.chargeRef) {
      charge = await this.stripe.charges.retrieve(
        input.chargeRef,
        { expand: ['balance_transaction'] },
        options,
      );
    } else if (input.paymentIntentRef) {
      const pi = await this.stripe.paymentIntents.retrieve(
        input.paymentIntentRef,
        { expand: ['latest_charge.balance_transaction'] },
        options,
      );
      if (typeof pi.latest_charge === 'object') charge = pi.latest_charge;
    }
    if (!charge || !charge.paid || !charge.captured) return null;
    const transaction = charge.balance_transaction;
    if (!transaction || typeof transaction === 'string' || transaction.type !== 'charge')
      return null;
    // A valid zero is evidence; missing/malformed money is not.
    if (
      !Number.isSafeInteger(transaction.fee) ||
      transaction.fee < 0 ||
      !/^[a-z]{3}$/.test(transaction.currency) ||
      !Number.isSafeInteger(transaction.created) ||
      transaction.created <= 0 ||
      !transaction.id.startsWith('txn_')
    )
      return null;
    const occurredAt = new Date(transaction.created * 1000);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    // Account identity survives API-key rotation. Never persist/log a key or its hash.
    if (!this.accountRef)
      this.accountRef = (await this.stripe.accounts.retrieve(undefined, options)).id;
    return {
      provider: 'stripe',
      accountRef: this.accountRef,
      environment: charge.livemode ? 'live' : 'test',
      externalRef: transaction.id,
      amountCents: transaction.fee,
      currency: transaction.currency,
      occurredAt,
      source: 'stripe_balance_transaction',
    };
  }
}
