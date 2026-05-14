import { SpanStatusCode } from '@opentelemetry/api';
import type { FundraisingCampaignRepository } from '../adapters/fundraising-campaign-repository.js';
import type { Campaign, CreateFundraisingCampaignInput } from '../domain/fundraising-campaign.js';
import { CreateFundraisingCampaignInputSchema } from '../domain/fundraising-campaign.js';
import { FundraisingInvalidInputError } from '../errors/fundraising-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface CreateFundraisingCampaignDeps {
  readonly campaignRepository: FundraisingCampaignRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria uma campanha de arrecadação (agregado vazio de opções).
 */
export async function createFundraisingCampaign(
  deps: CreateFundraisingCampaignDeps,
  input: CreateFundraisingCampaignInput,
): Promise<Campaign> {
  const { campaignRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('createFundraisingCampaign', async (span) => {
    try {
      const parsed = CreateFundraisingCampaignInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new FundraisingInvalidInputError(message);
      }

      span.setAttribute('fundraising.campaign.id', parsed.data.id);
      span.setAttribute('fundraising.campaign.title.length', parsed.data.title.length);

      const campaign: Campaign = {
        id: parsed.data.id,
        creatorAccountId: parsed.data.creatorAccountId,
        receiverId: parsed.data.receiverId,
        title: parsed.data.title,
        options: [],
        createdAt: clock(),
      };

      await campaignRepository.save(campaign);

      logger.info('fundraising.campaign.created', {
        campaignId: campaign.id,
        titleLength: campaign.title.length,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return campaign;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
