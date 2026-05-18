import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type LancamentoFinanceiro,
  type RegistrarEfeitosFinanceirosPagamentoAprovadoInput,
  RegistrarEfeitosFinanceirosPagamentoAprovadoInputSchema,
} from '../../domain/financeiro/financeiro.js';
import { FinanceiroInputInvalidoError } from '../../errors/financeiro/input-invalido.error.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../errors/financeiro/pagamento-ja-registrado.error.js';
import { FinanceiroPagamentoNaoAprovadoError } from '../../errors/financeiro/pagamento-nao-aprovado.error.js';
import type { Observability } from '../../observability/observability.js';

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

      const { idPagamento, idContribuicao, idRecebedor, statusPagamento, composicaoValores } =
        parsed.data;

      span.setAttribute('financeiro.pagamento.id', idPagamento);
      span.setAttribute('financeiro.contribuicao.id', idContribuicao);
      span.setAttribute('financeiro.recebedor.id', idRecebedor);

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
        idRecebedor,
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
