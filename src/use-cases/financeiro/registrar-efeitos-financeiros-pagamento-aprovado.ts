import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import { IdCampanhaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type LancamentoFinanceiro,
  StatusPagamentoFinanceiroSchema,
} from '../../domain/financeiro/entities/lancamento-financeiro.js';
import {
  IdContribuicaoReferenciaSchema,
  IdPagamentoReferenciaSchema,
} from '../../domain/financeiro/value-objects/ids.js';
import { SnapshotComposicaoValoresFinanceiroSchema } from '../../domain/financeiro/value-objects/snapshot-composicao-valores-financeiro.js';
import { FinanceiroInputInvalidoError } from '../../errors/financeiro/input-invalido.error.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../errors/financeiro/pagamento-ja-registrado.error.js';
import { FinanceiroPagamentoNaoAprovadoError } from '../../errors/financeiro/pagamento-nao-aprovado.error.js';
import type { Observability } from '../../observability/observability.js';

export const RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema = z.object({
  idPagamento: IdPagamentoReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  idCampanha: IdCampanhaSchema,
  statusPagamento: StatusPagamentoFinanceiroSchema,
  composicaoValores: SnapshotComposicaoValoresFinanceiroSchema,
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
 * Registra os efeitos financeiros de um pagamento aprovado sem conhecer o contribuinte.
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

      const { idPagamento, idContribuicao, idCampanha, statusPagamento, composicaoValores } =
        parsed.data;

      span.setAttribute('financeiro.pagamento.id', idPagamento);
      span.setAttribute('financeiro.contribuicao.id', idContribuicao);
      span.setAttribute('financeiro.campanha.id', idCampanha);

      if (statusPagamento !== 'aprovado') {
        throw new FinanceiroPagamentoNaoAprovadoError(idPagamento, statusPagamento);
      }

      const lancamentosExistentes =
        await livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
      if (lancamentosExistentes.length > 0) {
        throw new FinanceiroPagamentoJaRegistradoError(idPagamento);
      }

      const now = clock();
      let lancamentos: readonly LancamentoFinanceiro[];
      try {
        lancamentos = criarLancamentosParaPagamentoAprovado(
          parsed.data,
          {
            idLancamentoRecebedor: randomUUID(),
            idLancamentoReceitaPlataforma: randomUUID(),
          },
          now,
        );
      } catch (error) {
        throw new FinanceiroInputInvalidoError((error as Error).message);
      }

      await livroFinanceiroRepository.saveLancamentos(lancamentos);

      logger.info('financeiro.efeitos.registrados', {
        idPagamento,
        idContribuicao,
        idCampanha,
        receiverAmountCents: composicaoValores.receiverAmountCents,
        platformRevenueAmountCents: composicaoValores.feeAmountCents,
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
