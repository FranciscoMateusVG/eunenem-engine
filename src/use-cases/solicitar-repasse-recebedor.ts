import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../adapters/financeiro-livro-repository.js';
import {
  calcularSaldoRecebedor,
  criarRepasseRecebedorSolicitado,
  type RepasseRecebedor,
  type SolicitarRepasseRecebedorInput,
  SolicitarRepasseRecebedorInputSchema,
} from '../domain/financeiro.js';
import { FinanceiroInputInvalidoError } from '../errors/financeiro-input-invalido.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../errors/financeiro-saldo-disponivel-insuficiente.error.js';
import type { Observability } from '../observability/observability.js';

export interface SolicitarRepasseRecebedorDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria um pedido inicial de resgate/repasse sem executar transferência bancária.
 */
export async function solicitarRepasseRecebedor(
  deps: SolicitarRepasseRecebedorDeps,
  input: SolicitarRepasseRecebedorInput,
): Promise<RepasseRecebedor> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('solicitarRepasseRecebedor', async (span) => {
    try {
      const parsed = SolicitarRepasseRecebedorInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }

      const { idRepasse, idRecebedor, amountCents } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);
      span.setAttribute('financeiro.recebedor.id', idRecebedor);
      span.setAttribute('financeiro.repasse.amount_cents', amountCents);

      const lancamentos = await livroFinanceiroRepository.findLancamentosByIdRecebedor(idRecebedor);
      const saldo = calcularSaldoRecebedor(idRecebedor, lancamentos);
      if (saldo.valorDisponivelCents < amountCents) {
        throw new FinanceiroSaldoDisponivelInsuficienteError(
          idRecebedor,
          amountCents,
          saldo.valorDisponivelCents,
        );
      }

      const repasse = criarRepasseRecebedorSolicitado(parsed.data, clock());
      await livroFinanceiroRepository.saveRepasse(repasse);

      logger.info('financeiro.repasse.solicitado', {
        idRepasse,
        idRecebedor,
        amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return repasse;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
