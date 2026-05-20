import { SpanStatusCode } from '@opentelemetry/api';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import {
  type CalcularComposicaoValoresInput,
  CalcularComposicaoValoresInputSchema,
  type ComposicaoValores,
  calcularComposicaoValores as calcularComposicaoValoresDominio,
  RegraTaxaSchema,
} from '../../domain/taxas/taxas.js';
import { TaxasInputInvalidoError } from '../../errors/taxas/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export interface CalcularComposicaoValoresDeps {
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
}

/**
 * Calcula a composição de valores do BC Taxas sem conhecer entidades de Arrecadação.
 */
export async function calcularComposicaoValores(
  deps: CalcularComposicaoValoresDeps,
  input: CalcularComposicaoValoresInput,
): Promise<ComposicaoValores> {
  const { provedorRegraTaxa, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('calcularComposicaoValores', async (span) => {
    try {
      const parsedInput = CalcularComposicaoValoresInputSchema.safeParse(input);
      if (!parsedInput.success) {
        const message = parsedInput.error.issues.map((i) => i.message).join('; ');
        throw new TaxasInputInvalidoError(message);
      }

      span.setAttribute('taxas.contribuicao.id', parsedInput.data.idContribuicao);
      span.setAttribute(
        'taxas.contribuicao.amount_cents',
        parsedInput.data.contributionAmountCents,
      );

      const regraAtiva = await provedorRegraTaxa.getRegraAtiva();
      const parsedRule = RegraTaxaSchema.safeParse(regraAtiva);
      if (!parsedRule.success) {
        const message = parsedRule.error.issues.map((i) => i.message).join('; ');
        throw new TaxasInputInvalidoError(message);
      }

      const composicao = calcularComposicaoValoresDominio(parsedRule.data, parsedInput.data);

      logger.info('taxas.composicao.calculada', {
        idContribuicao: composicao.idContribuicao,
        contributionAmountCents: composicao.contributionAmountCents,
        feeAmountCents: composicao.feeAmountCents,
        totalPaidCents: composicao.totalPaidCents,
        receiverAmountCents: composicao.receiverAmountCents,
        responsavelTaxa: composicao.responsavelTaxa,
      });

      span.setAttribute('taxas.taxa.amount_cents', composicao.feeAmountCents);
      span.setAttribute('taxas.total_pago.amount_cents', composicao.totalPaidCents);
      span.setStatus({ code: SpanStatusCode.OK });
      return composicao;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
