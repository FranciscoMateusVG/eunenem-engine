import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ProvedorRegraTaxa } from '../../adapters/taxas/regra-provider.js';
import { MoneyCentsSchema } from '../../domain/money.js';
import { obterTarifaPorTipo } from '../../domain/taxas/entities/regra-taxa.js';
import {
  type ComposicaoValores,
  calcularComposicaoValores as calcularComposicaoValoresDominio,
} from '../../domain/taxas/value-objects/composicao-valores.js';
import {
  IdContribuicaoReferenciaSchema,
  IdPlataformaReferenciaSchema,
} from '../../domain/taxas/value-objects/ids.js';
import { TipoOpcaoContribuicaoReferenciaSchema } from '../../domain/taxas/value-objects/tarifa-tipo.js';
import { TaxasInputInvalidoError } from '../../errors/taxas/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const CalcularComposicaoValoresInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  idContribuicao: IdContribuicaoReferenciaSchema,
  tipo: TipoOpcaoContribuicaoReferenciaSchema,
  contributionAmountCents: MoneyCentsSchema,
});

export type CalcularComposicaoValoresInput = z.infer<typeof CalcularComposicaoValoresInputSchema>;

export interface CalcularComposicaoValoresDeps {
  readonly provedorRegraTaxa: ProvedorRegraTaxa;
  readonly observability: Observability;
}

/**
 * Calcula a composição de valores do BC Taxas para uma contribuição de uma
 * plataforma específica. Carrega a RegraTaxa da plataforma, resolve a
 * TarifaTipo para o tipo informado, e aplica os cálculos puros do domínio.
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

      const { idPlataforma, idContribuicao, tipo, contributionAmountCents } = parsedInput.data;

      span.setAttribute('taxas.plataforma.id', idPlataforma);
      span.setAttribute('taxas.contribuicao.id', idContribuicao);
      span.setAttribute('taxas.contribuicao.tipo', tipo);
      span.setAttribute('taxas.contribuicao.amount_cents', contributionAmountCents);

      const regraAtiva = await provedorRegraTaxa.getRegraAtiva(idPlataforma);
      const tarifa = obterTarifaPorTipo(regraAtiva, tipo);

      const composicao = calcularComposicaoValoresDominio(tarifa, {
        idContribuicao,
        contributionAmountCents,
      });

      logger.info('taxas.composicao.calculada', {
        idPlataforma,
        idContribuicao: composicao.idContribuicao,
        tipo,
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
