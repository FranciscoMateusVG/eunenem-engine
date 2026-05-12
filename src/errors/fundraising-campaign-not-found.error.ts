import type { CampaignId } from '../domain/fundraising-campaign.js';

export class FundraisingCampaignNotFoundError extends Error {
  public readonly code = 'FUNDRAISING_CAMPAIGN_NOT_FOUND' as const;

  constructor(public readonly campaignId: CampaignId) {
    super(`Fundraising campaign not found: ${campaignId}`);
    this.name = 'FundraisingCampaignNotFoundError';
  }
}
