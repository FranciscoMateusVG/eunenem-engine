import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribution, ContributionId } from '../domain/fundraising-contribution.js';
import { FundraisingContributionAlreadyExistsError } from '../errors/fundraising-contribution-already-exists.error.js';
import type { FundraisingContributionRepository } from './fundraising-contribution-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'fundraising_contributions',
} as const;

export class FundraisingContributionRepositoryMemory implements FundraisingContributionRepository {
  private readonly contributions = new Map<ContributionId, Contribution>();

  async save(contribution: Contribution): Promise<void> {
    return tracer.startActiveSpan('db.fundraising_contributions.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        if (this.contributions.has(contribution.id)) {
          throw new FundraisingContributionAlreadyExistsError(contribution.id);
        }
        this.contributions.set(contribution.id, contribution);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findById(id: ContributionId): Promise<Contribution | undefined> {
    return tracer.startActiveSpan('db.fundraising_contributions.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.contributions.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
