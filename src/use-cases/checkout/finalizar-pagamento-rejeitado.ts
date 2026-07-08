import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';
import { rejeitarPagamento } from '../pagamentos/rejeitar-pagamento.js';

export const FinalizarPagamentoRejeitadoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
});

export type FinalizarPagamentoRejeitadoInput = z.infer<
  typeof FinalizarPagamentoRejeitadoInputSchema
>;

export interface FinalizarPagamentoRejeitadoResult {
  readonly pagamento: Pagamento;
}

export interface FinalizarPagamentoRejeitadoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Process Manager: depois que o provedor responde com rejeição, este
 * orquestrador *avança* o workflow — rejeita o Pagamento. Símétrico ao
 * `finalizarPagamentoAprovado`.
 *
 * **Plan 0015 (aperture-ucgok).** The `desassociarContribuinteContribuicao`
 * compensation step is GONE. Pre-collapse, the saga had to undo the
 * status flip on contribuição; with status removed there's nothing to
 * compensate — the slot was never touched, and a rejected pagamento
 * just stays as an audit row. The contribuição remains available for
 * the next visitor automatically (the indisponivel predicate over
 * pagamentos doesn't match rejeitado rows).
 *
 * **5-state FSM:** both `pendente` AND `processing` are valid source
 * states for the rejeitado transition (card flows can fail before or
 * during settlement; pix flows fail after the QR was scanned but
 * before the bank confirmed). Idempotent on rejeitado (replay path).
 *
 * Cross-BC context: Pagamentos não conhece `idCampanha` nem
 * `idPlataforma` (isolamento de BC). O process manager carrega
 * Contribuicao → Campanha para juntar os identificadores e estampar
 * `idPlataforma` no span/log para rastreabilidade.
 *
 * **Idempotency contract:** calling this twice with the same
 * `idPagamento` produces the same `{pagamento}` result. Pagamento
 * already `rejeitado` → skip provider call, reuse existing state.
 */
export async function finalizarPagamentoRejeitado(
  deps: FinalizarPagamentoRejeitadoDeps,
  input: FinalizarPagamentoRejeitadoInput,
): Promise<FinalizarPagamentoRejeitadoResult> {
  const {
    pagamentoRepository,
    pagamentoProvider,
    pagamentoEventPublisher,
    contribuicaoRepository,
    campanhaRepository,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('finalizarPagamentoRejeitado', async (span) => {
    try {
      const parsed = FinalizarPagamentoRejeitadoInputSchema.parse(input);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);

      // step 1: reject via Pagamentos — with idempotent replay.
      // Both `pendente` and `processing` are valid source states.
      const existingPagamento = await pagamentoRepository.findById(parsed.idPagamento);
      let rejeitado: Pagamento;
      if (existingPagamento?.status === 'rejeitado') {
        rejeitado = existingPagamento;
        logger.info('checkout.pagamento.replay_rejeicao', { idPagamento: parsed.idPagamento });
      } else if (
        existingPagamento &&
        existingPagamento.status !== 'pendente' &&
        existingPagamento.status !== 'processing'
      ) {
        throw new PagamentoTransicaoStatusInvalidaError(
          existingPagamento.id,
          existingPagamento.status,
          'rejeitado',
        );
      } else {
        rejeitado = await rejeitarPagamento(
          {
            pagamentoRepository,
            pagamentoProvider,
            pagamentoEventPublisher,
            clock,
            observability,
          },
          { idPagamento: parsed.idPagamento },
        );
      }

      // step 2: cross-BC context — Plan 0016 Phase 2 (aperture-eg1s2):
      // logging-only — no state changes anywhere downstream. Anchor
      // contribuição from the first contribuicao item; campanha from
      // the cart-scope idCampanha.
      const anchorItem = rejeitado.intencao.items.find((it) => it.tipo === 'contribuicao');
      if (!anchorItem || anchorItem.tipo !== 'contribuicao') {
        throw new Error(`Pagamento ${rejeitado.id} has no contribuicao item — invalid cart shape.`);
      }
      const idContribuicaoAnchor = anchorItem.idContribuicao;
      const contribuicao = await contribuicaoRepository.findById(idContribuicaoAnchor);
      if (!contribuicao) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicaoAnchor);
      }
      const campanha = await campanhaRepository.findById(rejeitado.intencao.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(rejeitado.intencao.idCampanha);
      }

      span.setAttribute('checkout.contribuicao.anchor.id', idContribuicaoAnchor);
      span.setAttribute('checkout.campanha.id', campanha.id);
      span.setAttribute('checkout.plataforma.id', campanha.idPlataforma);
      span.setAttribute('checkout.cart.itens_count', rejeitado.intencao.items.length);

      logger.info('checkout.pagamento.rejeitado_finalizado', {
        idPlataforma: campanha.idPlataforma,
        idCampanha: campanha.id,
        idContribuicaoAnchor,
        idPagamento: rejeitado.id,
        numeroDeItens: rejeitado.intencao.items.length,
        amountCents: rejeitado.intencao.composicaoValoresAggregate.totalPaidCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { pagamento: rejeitado };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
