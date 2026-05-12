import { SpanStatusCode } from '@opentelemetry/api';
import type { FundraisingCampaignRepository } from '../adapters/fundraising-campaign-repository.js';
import {
  type AddFundraisingContributionOptionInput,
  AddFundraisingContributionOptionInputSchema,
  type Campaign,
  type ContributionOption,
  ContributionOptionSchema,
  campaignWithOption,
} from '../domain/fundraising-campaign.js';
import { FundraisingCampaignNotFoundError } from '../errors/fundraising-campaign-not-found.error.js';
import { FundraisingDuplicateOptionIdError } from '../errors/fundraising-duplicate-option-id.error.js';
import { FundraisingInvalidInputError } from '../errors/fundraising-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface AddFundraisingContributionOptionDeps {
  readonly campaignRepository: FundraisingCampaignRepository;
  readonly observability: Observability;
}

/**
 * Adiciona uma opção de contribuição a uma campanha existente.
 */
export async function addFundraisingContributionOption(
  deps: AddFundraisingContributionOptionDeps,
  input: AddFundraisingContributionOptionInput,
): Promise<Campaign> {
  const { campaignRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('addFundraisingContributionOption', async (span) => {
    try {
      const parsed = AddFundraisingContributionOptionInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new FundraisingInvalidInputError(message);
      }

      const { campaignId, optionId, amountCents, label } = parsed.data;

      span.setAttribute('fundraising.campaign.id', campaignId);
      span.setAttribute('fundraising.option.id', optionId);

      const existing = await campaignRepository.findById(campaignId);
      if (!existing) {
        throw new FundraisingCampaignNotFoundError(campaignId);
      }

      if (existing.options.some((o) => o.id === optionId)) {
        throw new FundraisingDuplicateOptionIdError(optionId);
      }

      const optionParsed = ContributionOptionSchema.safeParse({
        id: optionId,
        amountCents,
        label,
      });
      if (!optionParsed.success) {
        const message = optionParsed.error.issues.map((i) => i.message).join('; ');
        throw new FundraisingInvalidInputError(message);
      }

      const option: ContributionOption = optionParsed.data;
      const updated = campaignWithOption(existing, option);

      await campaignRepository.save(updated);

      logger.info('fundraising.campaign.option_added', {
        campaignId,
        optionId,
        amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return updated;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
