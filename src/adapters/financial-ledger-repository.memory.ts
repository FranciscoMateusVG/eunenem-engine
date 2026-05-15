import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  FinancialEntry,
  FinancialEntryId,
  FinancialPaymentReferenceId,
  FinancialPayoutId,
  FinancialReceiverId,
  ReceiverPayout,
} from '../domain/financial.js';
import { FinancialPaymentAlreadyRecordedError } from '../errors/financial-payment-already-recorded.error.js';
import type { FinancialLedgerRepository } from './financial-ledger-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'financial_ledger',
} as const;

export class FinancialLedgerRepositoryMemory implements FinancialLedgerRepository {
  private readonly entries = new Map<FinancialEntryId, FinancialEntry>();
  private readonly payoutRequests = new Map<FinancialPayoutId, ReceiverPayout>();

  async saveEntries(entries: readonly FinancialEntry[]): Promise<void> {
    return tracer.startActiveSpan('db.financial_ledger.entries.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const paymentIds = new Set(entries.map((entry) => entry.paymentId));
        for (const paymentId of paymentIds) {
          if (await this.hasEntriesForPayment(paymentId)) {
            throw new FinancialPaymentAlreadyRecordedError(paymentId);
          }
        }

        for (const entry of entries) {
          this.entries.set(entry.id, entry);
        }

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findEntriesByPaymentId(
    paymentId: FinancialPaymentReferenceId,
  ): Promise<readonly FinancialEntry[]> {
    return tracer.startActiveSpan('db.financial_ledger.entries.findByPaymentId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.entries.values()].filter((entry) => entry.paymentId === paymentId);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findEntriesByReceiverId(
    receiverId: FinancialReceiverId,
  ): Promise<readonly FinancialEntry[]> {
    return tracer.startActiveSpan('db.financial_ledger.entries.findByReceiverId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.entries.values()].filter(
          (entry) => entry.receiverId === receiverId,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findPlatformRevenueEntries(): Promise<readonly FinancialEntry[]> {
    return tracer.startActiveSpan(
      'db.financial_ledger.entries.findPlatformRevenue',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.entries.values()].filter(
            (entry) => entry.type === 'platform_revenue_credit',
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async savePayoutRequest(payout: ReceiverPayout): Promise<void> {
    return tracer.startActiveSpan('db.financial_ledger.payout_requests.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        this.payoutRequests.set(payout.id, payout);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findPayoutRequestById(payoutId: FinancialPayoutId): Promise<ReceiverPayout | undefined> {
    return tracer.startActiveSpan('db.financial_ledger.payout_requests.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.payoutRequests.get(payoutId);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findPayoutRequestsByReceiverId(
    receiverId: FinancialReceiverId,
  ): Promise<readonly ReceiverPayout[]> {
    return tracer.startActiveSpan(
      'db.financial_ledger.payout_requests.findByReceiverId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.payoutRequests.values()].filter(
            (payout) => payout.receiverId === receiverId,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async hasEntriesForPayment(paymentId: FinancialPaymentReferenceId): Promise<boolean> {
    const entries = await this.findEntriesByPaymentId(paymentId);
    return entries.length > 0;
  }
}
