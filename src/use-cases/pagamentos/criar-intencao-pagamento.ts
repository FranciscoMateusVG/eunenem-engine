import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { ItemDoPagamentoSchema } from '../../domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarEventoPagamento,
  criarPagamentoPendente,
  type Pagamento,
} from '../../domain/pagamentos/entities/pagamento.js';
import {
  IdIntencaoPagamentoSchema,
  IdPagamentoSchema,
} from '../../domain/pagamentos/value-objects/ids.js';
import { MetodoPagamentoSchema } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';
import { SnapshotComposicaoValoresAggregateSchema } from '../../domain/pagamentos/value-objects/snapshot-composicao-valores-aggregate.js';
import { PagamentosInputInvalidoError } from '../../errors/pagamentos/input-invalido.error.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoValorDivergenteError } from '../../errors/pagamentos/valor-divergente.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2): reshape to multi-item cart input.
 * Pre-0016 the use-case accepted `composicaoValores` (single-item
 * snapshot) and the IntencaoPagamento factory laid it out at root.
 * Post-0016 the input carries the cart (items + aggregate snapshot +
 * idCampanha) and `criarPagamentoPendente` validates the
 * cart-construction invariants.
 *
 * The event published carries the new shape per operator review lock
 * #19 — drop idContribuicao, add idCampanha + numeroDeItens +
 * idsContribuicoes — sourced inside `criarEventoPagamento` from the
 * pagamento entity (Phase 1 work).
 */
export const CriarIntencaoPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
  idIntencaoPagamento: IdIntencaoPagamentoSchema,
  items: z.array(ItemDoPagamentoSchema).min(1),
  composicaoValoresAggregate: SnapshotComposicaoValoresAggregateSchema,
  valorACobrarCents: MoneyCentsSchema,
  metodo: MetodoPagamentoSchema,
  /**
   * Provider-side session reference (aperture-xaha2). Pass the Stripe
   * checkout session id when creating via the CheckoutSessionProvider
   * flow; omit / pass null for the synchronous solicitarPagamento flow.
   */
  externalRef: z.string().trim().min(1).max(255).nullable().optional(),
});

export type CriarIntencaoPagamentoInput = z.infer<typeof CriarIntencaoPagamentoInputSchema>;

export interface CriarIntencaoPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria uma intenção de pagamento (cart shape). Não conhece campanha,
 * presente, rifa ou convite — somente recebe os items já calculados +
 * o aggregate snapshot vindos da saga.
 */
export async function criarIntencaoPagamento(
  deps: CriarIntencaoPagamentoDeps,
  input: CriarIntencaoPagamentoInput,
): Promise<Pagamento> {
  const { pagamentoRepository, pagamentoEventPublisher, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarIntencaoPagamento', async (span) => {
    try {
      const parsed = CriarIntencaoPagamentoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PagamentosInputInvalidoError(message);
      }

      const {
        idPagamento,
        idIntencaoPagamento,
        items,
        composicaoValoresAggregate,
        valorACobrarCents,
        metodo,
        externalRef,
      } = parsed.data;

      span.setAttributes({
        'pagamento.id': idPagamento,
        'pagamento.intencao.id': idIntencaoPagamento,
        'pagamento.intencao.id_campanha': composicaoValoresAggregate.idCampanha,
        'pagamento.intencao.numero_de_itens': items.length,
        'pagamento.amount_cents': valorACobrarCents,
        'pagamento.method': metodo,
      });
      if (externalRef) {
        span.setAttribute('pagamento.external_ref.present', true);
      }

      if (valorACobrarCents !== composicaoValoresAggregate.totalPaidCents) {
        throw new PagamentoValorDivergenteError(
          composicaoValoresAggregate.totalPaidCents,
          valorACobrarCents,
        );
      }

      const existing = await pagamentoRepository.findById(idPagamento);
      if (existing) {
        throw new PagamentoJaExisteError(idPagamento, idIntencaoPagamento);
      }

      const now = clock();
      const pagamento = criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento,
        items,
        composicaoValoresAggregate,
        valorACobrarCents,
        metodo,
        externalRef: externalRef ?? null,
        criadoEm: now,
      });

      await pagamentoRepository.save(pagamento);
      await pagamentoEventPublisher.publish(
        criarEventoPagamento({
          id: randomUUID(),
          tipo: 'payment.intent_created',
          pagamento,
          ocorridoEm: now,
        }),
      );

      logger.info('pagamento.intencao_criada', {
        idPagamento,
        idIntencaoPagamento,
        idCampanha: pagamento.intencao.idCampanha,
        numeroDeItens: pagamento.intencao.items.length,
        totalPaidCents: pagamento.intencao.composicaoValoresAggregate.totalPaidCents,
        metodo,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return pagamento;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
