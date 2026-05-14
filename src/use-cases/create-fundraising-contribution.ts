import { SpanStatusCode } from '@opentelemetry/api';
import type { FundraisingCampaignRepository } from '../adapters/fundraising-campaign-repository.js';
import type { FundraisingContributionRepository } from '../adapters/fundraising-contribution-repository.js';
import { findContributionOption } from '../domain/fundraising-campaign.js';
import type {
  Contribution,
  CreateFundraisingContributionInput,
} from '../domain/fundraising-contribution.js';
import { CreateFundraisingContributionInputSchema } from '../domain/fundraising-contribution.js';
import { FundraisingCampaignNotFoundError } from '../errors/fundraising-campaign-not-found.error.js';
import { FundraisingContributionAlreadyExistsError } from '../errors/fundraising-contribution-already-exists.error.js';
import { FundraisingContributionOptionNotFoundError } from '../errors/fundraising-contribution-option-not-found.error.js';
import { FundraisingInvalidInputError } from '../errors/fundraising-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface CreateFundraisingContributionDeps {
  readonly campaignRepository: FundraisingCampaignRepository;
  readonly contributionRepository: FundraisingContributionRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Regista uma contribuição de visitante a partir de uma opção da campanha (valor copiado da opção).
 */
export async function createFundraisingContribution(
  deps: CreateFundraisingContributionDeps,
  input: CreateFundraisingContributionInput,
): Promise<Contribution> {
  const { campaignRepository, contributionRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('createFundraisingContribution', async (span) => {
    try {
      const parsed = CreateFundraisingContributionInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new FundraisingInvalidInputError(message);
      }

      const { id, campaignId, contributionOptionId, contributor } = parsed.data;

      span.setAttribute('fundraising.contribution.id', id);
      span.setAttribute('fundraising.campaign.id', campaignId);

      const existingContribution = await contributionRepository.findById(id);
      if (existingContribution) {
        throw new FundraisingContributionAlreadyExistsError(id);
      }

      const campaign = await campaignRepository.findById(campaignId);
      if (!campaign) {
        throw new FundraisingCampaignNotFoundError(campaignId);
      }

      const option = findContributionOption(campaign, contributionOptionId);
      if (!option) {
        throw new FundraisingContributionOptionNotFoundError(campaignId, contributionOptionId);
      }

      const contribution: Contribution = {
        id,
        campaignId,
        contributionOptionId,
        amountCents: option.amountCents,
        contributor,
        status: 'pending_payment',
        createdAt: clock(),
      };

      await contributionRepository.save(contribution);

      logger.info('fundraising.contribution.created', {
        contributionId: id,
        campaignId,
        amountCents: contribution.amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return contribution;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
