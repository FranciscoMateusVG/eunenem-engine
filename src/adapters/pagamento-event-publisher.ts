import type { EventoPagamento } from '../domain/pagamentos.js';

/**
 * Publicação de eventos de pagamento (porta).
 */
export interface PagamentoEventPublisher {
  publish(evento: EventoPagamento): Promise<void>;
}
