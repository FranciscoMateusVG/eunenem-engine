import { SpanStatusCode } from '@opentelemetry/api';
import type { FinancialLedgerRepository } from '../adapters/financial-ledger-repository.js';
import { calculatePlatformRevenue, type PlatformRevenue } from '../domain/financial.js';
import type { Observability } from '../observability/observability.js';

export interface GetPlatformRevenueDeps {
  readonly financialLedgerRepository: FinancialLedgerRepository;
  readonly observability: Observability;
}

/**
 * Consulta a receita acumulada da plataforma a partir dos lançamentos financeiros.
 */
export async function getPlatformRevenue(deps: GetPlatformRevenueDeps): Promise<PlatformRevenue> {
  const { financialLedgerRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('getPlatformRevenue', async (span) => {
    try {
      const entries = await financialLedgerRepository.findPlatformRevenueEntries();
      const revenue = calculatePlatformRevenue(entries);

      span.setStatus({ code: SpanStatusCode.OK });
      return revenue;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
