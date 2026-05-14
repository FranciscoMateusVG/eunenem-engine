import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { FeeRule } from '../domain/fees.js';
import { DEFAULT_FEE_RULE } from '../domain/fees.js';
import type { FeeRuleProvider } from './fee-rule-provider.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'fee_rules',
} as const;

export class FeeRuleProviderMemory implements FeeRuleProvider {
  constructor(private readonly activeRule: FeeRule = DEFAULT_FEE_RULE) {}

  async getActiveRule(): Promise<FeeRule> {
    return tracer.startActiveSpan('db.fee_rules.getActive', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        span.setStatus({ code: SpanStatusCode.OK });
        return this.activeRule;
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
