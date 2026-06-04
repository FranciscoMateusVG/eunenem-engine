import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import { IdCampanhaSchema } from '../../../domain/arrecadacao/value-objects/ids.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroSaldoDisponivelInsuficienteError } from '../../../errors/pagamentos/financeiro/saldo-disponivel-insuficiente.error.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * aperture-s03dr. Solicitação de repasse — sweep the recebedor's
 * currently-disponível lançamentos for the campanha and snapshot them
 * into a new pending `RepasseRecebedor`.
 *
 * Before s03dr: the input carried an explicit `amountCents` and the
 * use-case only validated that the recebedor had at least that much
 * disponível. After s03dr: the use-case BOTH preflights the disponível
 * set AND atomically claims it via `solicitarRepasseTransaction`. The
 * caller no longer passes `amountCents` — the snapshot IS the amount
 * (sweep semantics).
 *
 * Concurrency: at most one pending repasse per campanha. Enforced by
 * the unique partial index `repasses_um_solicitado_por_campanha`
 * (postgres) and a preflight scan (memory). On race, the loser
 * surfaces `FinanceiroRepasseJaPendenteError`.
 *
 * Empty-set semantics: if the recebedor has nothing disponível right
 * now (no aprovado pagamentos with available_on <= now), this throws
 * `FinanceiroSaldoDisponivelInsuficienteError(idCampanha, 0, 0)`.
 * Track 2 tRPC maps to 409.
 */
export const SolicitarRepasseRecebedorInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  idCampanha: IdCampanhaSchema,
});

export type SolicitarRepasseRecebedorInput = Readonly<
  z.infer<typeof SolicitarRepasseRecebedorInputSchema>
>;

export interface SolicitarRepasseRecebedorDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

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

      const { idRepasse, idCampanha } = parsed.data;
      const now = clock();
      span.setAttribute('financeiro.repasse.id', idRepasse);
      span.setAttribute('financeiro.campanha.id', idCampanha);

      // Preflight: if there's nothing eligible right now, fail fast with
      // SaldoDisponivelInsuficiente — don't even open a transaction.
      // (Cheaper than letting the transaction succeed with amountCents=0
      // and then complain at the call-site.)
      const eligible = await livroFinanceiroRepository.findLancamentosDisponiveisByIdCampanha(
        idCampanha,
        now,
      );
      if (eligible.length === 0) {
        throw new FinanceiroSaldoDisponivelInsuficienteError(idCampanha, 0, 0);
      }

      // Atomic claim. The repository's transaction re-runs the same
      // predicate under SELECT FOR UPDATE — the preflight check above is
      // an optimization, not a correctness gate.
      const { repasse, idsLancamentosClaimados } =
        await livroFinanceiroRepository.solicitarRepasseTransaction({
          idCampanha,
          idRepasse,
          solicitadoEm: now,
          now,
        });

      span.setAttribute('financeiro.repasse.amount_cents', repasse.amountCents);
      span.setAttribute('financeiro.repasse.lancamentos_count', idsLancamentosClaimados.length);

      logger.info('financeiro.repasse.solicitado', {
        idRepasse,
        idCampanha,
        amountCents: repasse.amountCents,
        lancamentosCount: idsLancamentosClaimados.length,
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
