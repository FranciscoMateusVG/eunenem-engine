import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Campaign, CampaignId } from '../domain/fundraising-campaign.js';
import type { FundraisingCampaignRepository } from './fundraising-campaign-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'fundraising_campaigns',
} as const;

export class FundraisingCampaignRepositoryMemory implements FundraisingCampaignRepository {
  private readonly campaigns = new Map<CampaignId, Campaign>();

  async save(campaign: Campaign): Promise<void> {
    return tracer.startActiveSpan('db.fundraising_campaigns.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        this.campaigns.set(campaign.id, campaign);
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

  async findById(id: CampaignId): Promise<Campaign | undefined> {
    return tracer.startActiveSpan('db.fundraising_campaigns.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.campaigns.get(id);
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
