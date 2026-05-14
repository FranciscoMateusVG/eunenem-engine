import type { CampaignId, ContributionOptionId } from '../domain/fundraising-campaign.js';

export class FundraisingContributionOptionNotFoundError extends Error {
  public readonly code = 'FUNDRAISING_CONTRIBUTION_OPTION_NOT_FOUND' as const;

  constructor(
    public readonly campaignId: CampaignId,
    public readonly optionId: ContributionOptionId,
  ) {
    super(`Contribution option "${optionId}" not found on campaign "${campaignId}".`);
    this.name = 'FundraisingContributionOptionNotFoundError';
  }
}
