import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import { IdCampanhaSchema } from '../../../domain/arrecadacao/value-objects/ids.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type IdsLancamentosFinanceirosPorPagamento,
  type IdsLancamentosPorItem,
  type ItemDoPagamentoFinanceiro,
  type LancamentoFinanceiro,
  StatusPagamentoFinanceiroSchema,
} from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import {
  IdContribuicaoReferenciaSchema,
  IdPagamentoReferenciaSchema,
} from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { SnapshotComposicaoValoresItemFinanceiroSchema } from '../../../domain/pagamentos/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';
import { IdItemDoPagamentoSchema } from '../../../domain/pagamentos/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
import { FinanceiroPagamentoNaoAprovadoError } from '../../../errors/pagamentos/financeiro/pagamento-nao-aprovado.error.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Multi-item input shape: caller
 * provides the cart's per-item financeiro snapshots + the cart-scope
 * idCampanha + idContribuicaoAnchor. Per-item ids are minted here for
 * the lançamentos.
 */
const ItemFinanceiroInputSchema = z.object({
  idItemPagamento: IdItemDoPagamentoSchema,
  composicaoValoresItem: SnapshotComposicaoValoresItemFinanceiroSchema,
});

export const RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema = z.object({
  idPagamento: IdPagamentoReferenciaSchema,
  /**
   * Anchor contribuição id — stamped on every lançamento (including
   * surcharge rows) for traceability. Sourced from the cart's first
   * contribuicao-tipo item.
   */
  idContribuicaoAnchor: IdContribuicaoReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  statusPagamento: StatusPagamentoFinanceiroSchema,
  items: z.array(ItemFinanceiroInputSchema).min(1),
});

export type RegistrarEfeitosFinanceirosPagamentoAprovadoInput = Readonly<
  z.infer<typeof RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema>
>;

export interface RegistrarEfeitosFinanceirosPagamentoAprovadoDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Registra os efeitos financeiros de um pagamento aprovado em shape
 * multi-item. Per-item lançamentos per locked decision #12:
 *   - contribuicao item → recebedor + receita_plataforma (2 rows)
 *   - passthrough_surcharge item → passthrough (1 row)
 */
export async function registrarEfeitosFinanceirosPagamentoAprovado(
  deps: RegistrarEfeitosFinanceirosPagamentoAprovadoDeps,
  input: RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
): Promise<readonly LancamentoFinanceiro[]> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registrarEfeitosFinanceirosPagamentoAprovado', async (span) => {
    try {
      const parsed = RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }

      const { idPagamento, idContribuicaoAnchor, idCampanha, statusPagamento, items } =
        parsed.data;

      span.setAttributes({
        'financeiro.pagamento.id': idPagamento,
        'financeiro.contribuicao.anchor.id': idContribuicaoAnchor,
        'financeiro.campanha.id': idCampanha,
        'financeiro.items.count': items.length,
      });

      if (statusPagamento !== 'aprovado') {
        throw new FinanceiroPagamentoNaoAprovadoError(idPagamento, statusPagamento);
      }

      const lancamentosExistentes =
        await livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
      if (lancamentosExistentes.length > 0) {
        throw new FinanceiroPagamentoJaRegistradoError(idPagamento);
      }

      // Mint per-item lancamento ids: 2 per contribuicao item, 1 per surcharge.
      const idsPorItem: IdsLancamentosPorItem[] = items.map((it) => {
        if (it.composicaoValoresItem.tipo === 'contribuicao') {
          return {
            idItemPagamento: it.idItemPagamento,
            idLancamentoRecebedor: randomUUID(),
            idLancamentoReceitaPlataforma: randomUUID(),
          };
        }
        return {
          idItemPagamento: it.idItemPagamento,
          idLancamentoPassthroughSurcharge: randomUUID(),
        };
      });

      const now = clock();
      let lancamentos: readonly LancamentoFinanceiro[];
      try {
        lancamentos = criarLancamentosParaPagamentoAprovado(
          {
            idPagamento,
            idCampanha,
            statusPagamento,
            idContribuicaoAnchor,
            items: items as readonly ItemDoPagamentoFinanceiro[],
          },
          idsPorItem as IdsLancamentosFinanceirosPorPagamento,
          now,
        );
      } catch (error) {
        throw new FinanceiroInputInvalidoError((error as Error).message);
      }

      await livroFinanceiroRepository.saveLancamentos(lancamentos);

      // Aggregate totals for the audit log.
      let totalReceiver = 0;
      let totalReceita = 0;
      let totalPassthrough = 0;
      for (const l of lancamentos) {
        if (l.tipo === 'credito_saldo_recebedor') totalReceiver += l.amountCents;
        else if (l.tipo === 'credito_receita_plataforma') totalReceita += l.amountCents;
        else if (l.tipo === 'credito_passthrough_surcharge') totalPassthrough += l.amountCents;
      }

      logger.info('financeiro.efeitos.registrados', {
        idPagamento,
        idCampanha,
        idContribuicaoAnchor,
        numeroDeItens: items.length,
        numeroDeLancamentos: lancamentos.length,
        totalReceiverAmountCents: totalReceiver,
        totalPlatformRevenueAmountCents: totalReceita,
        totalPassthroughSurchargeAmountCents: totalPassthrough,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return lancamentos;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
