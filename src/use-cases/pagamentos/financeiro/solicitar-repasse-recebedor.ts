import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import { IdCampanhaSchema } from '../../../domain/arrecadacao/value-objects/ids.js';
import {
  criarRepasseRecebedorSolicitado,
  type RepasseRecebedor,
} from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { calcularSaldoRecebedor } from '../../../domain/pagamentos/financeiro/value-objects/saldo-recebedor.js';
import { MoneyCentsSchema } from '../../../domain/money.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
import type { Observability } from '../../../observability/observability.js';

export const SolicitarRepasseRecebedorInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  idCampanha: IdCampanhaSchema,
  amountCents: MoneyCentsSchema,
});

export type SolicitarRepasseRecebedorInput = Readonly<
  z.infer<typeof SolicitarRepasseRecebedorInputSchema>
>;

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

      const { idRepasse, idCampanha, amountCents } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);
      span.setAttribute('financeiro.campanha.id', idCampanha);
      span.setAttribute('financeiro.repasse.amount_cents', amountCents);

      const lancamentos = await livroFinanceiroRepository.findLancamentosByIdCampanha(idCampanha);
      const saldo = calcularSaldoRecebedor(idCampanha, lancamentos);
      if (saldo.valorDisponivelCents < amountCents) {
        throw new FinanceiroSaldoDisponivelInsuficienteError(
          idCampanha,
          saldo.valorDisponivelCents,
          amountCents,
        );
      }

      const repasse = criarRepasseRecebedorSolicitado(parsed.data, clock());
      await livroFinanceiroRepository.saveRepasse(repasse);

      logger.info('financeiro.repasse.solicitado', {
        idRepasse,
        idCampanha,
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
