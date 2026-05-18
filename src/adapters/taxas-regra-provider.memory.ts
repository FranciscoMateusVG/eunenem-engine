import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { RegraTaxa } from '../domain/taxas.js';
import { REGRA_TAXA_PADRAO } from '../domain/taxas.js';
import type { ProvedorRegraTaxa } from './taxas-regra-provider.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'taxas_regras',
} as const;

export class ProvedorRegraTaxaMemory implements ProvedorRegraTaxa {
  constructor(private readonly regraAtiva: RegraTaxa = REGRA_TAXA_PADRAO) {}

  async getRegraAtiva(): Promise<RegraTaxa> {
    return tracer.startActiveSpan('db.taxas_regras.getRegraAtiva', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        span.setStatus({ code: SpanStatusCode.OK });
        return this.regraAtiva;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
