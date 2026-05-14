import type { MoneyCents } from '../domain/money.js';
import type {
  ExternalPaymentTransaction,
  PaymentId,
  PaymentIntentId,
  PaymentMethod,
} from '../domain/payments.js';

export interface RequestPaymentInput {
  readonly paymentId: PaymentId;
  readonly paymentIntentId: PaymentIntentId;
  readonly amountCents: MoneyCents;
  readonly method: PaymentMethod;
}

/**
 * Provedor de pagamento (porta). Por enquanto, será implementado por um fake.
 */
export interface PaymentProvider {
  requestPayment(input: RequestPaymentInput): Promise<ExternalPaymentTransaction>;
}
