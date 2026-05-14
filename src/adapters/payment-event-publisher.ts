import type { PaymentEvent } from '../domain/payments.js';

/**
 * Publicação de eventos de pagamento (porta).
 */
export interface PaymentEventPublisher {
  publish(event: PaymentEvent): Promise<void>;
}
