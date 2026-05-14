import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { MoneyCents } from '../domain/money.js';
import {
  type ExternalPaymentTransaction,
  ExternalPaymentTransactionSchema,
  type ExternalPaymentTransactionStatus,
  type ExternalTransactionId,
  ExternalTransactionIdSchema,
  type PaymentProviderName,
} from '../domain/payments.js';
import type { PaymentProvider, RequestPaymentInput } from './payment-provider.js';

const tracer = trace.getTracer('frame');

export interface PaymentProviderFakeOptions {
  readonly providerName?: PaymentProviderName;
  readonly resultStatus?: ExternalPaymentTransactionStatus;
  readonly transactionIdFactory?: () => string;
  readonly clock?: () => Date;
  readonly transactionAmountCents?: MoneyCents;
}

/**
 * Provedor fake determinístico para testes e aprendizagem, sem rede e sem SDK externo.
 */
export class PaymentProviderFake implements PaymentProvider {
  private readonly providerName: PaymentProviderName;
  private readonly resultStatus: ExternalPaymentTransactionStatus;
  private readonly transactionIdFactory: () => string;
  private readonly clock: () => Date;
  private readonly transactionAmountCents: MoneyCents | undefined;

  constructor(options: PaymentProviderFakeOptions = {}) {
    this.providerName = options.providerName ?? 'fake-provider';
    this.resultStatus = options.resultStatus ?? 'approved';
    this.transactionIdFactory = options.transactionIdFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.transactionAmountCents = options.transactionAmountCents;
  }

  async requestPayment(input: RequestPaymentInput): Promise<ExternalPaymentTransaction> {
    return tracer.startActiveSpan('payment_provider.fake.requestPayment', async (span) => {
      span.setAttribute('payment.id', input.paymentId);
      span.setAttribute('payment.intent.id', input.paymentIntentId);
      span.setAttribute('payment.amount_cents', input.amountCents);
      span.setAttribute('payment.method', input.method);

      try {
        const transactionId = ExternalTransactionIdSchema.parse(
          this.transactionIdFactory(),
        ) as ExternalTransactionId;
        const transaction = ExternalPaymentTransactionSchema.parse({
          id: transactionId,
          provider: this.providerName,
          status: this.resultStatus,
          amountCents: this.transactionAmountCents ?? input.amountCents,
          createdAt: this.clock(),
          rawStatus: this.resultStatus,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return transaction;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
