import type { Payment, PaymentId } from '../domain/payments.js';

/**
 * Persistência de Pagamentos (porta).
 */
export interface PaymentRepository {
  save(payment: Payment): Promise<void>;
  update(payment: Payment): Promise<void>;
  findById(id: PaymentId): Promise<Payment | undefined>;
}
