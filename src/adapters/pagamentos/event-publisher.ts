import type { EventoPagamento } from '../../domain/pagamentos/value-objects/evento-pagamento.js';

/**
 * Publicação de eventos de pagamento (porta).
 */
export interface PagamentoEventPublisher {
  publish(evento: EventoPagamento): Promise<void>;
}
