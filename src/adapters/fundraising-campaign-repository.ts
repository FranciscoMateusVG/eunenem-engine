import type { Campaign, CampaignId } from '../domain/fundraising-campaign.js';

/**
 * Persistência do agregado Campanha (porta).
 */
export interface FundraisingCampaignRepository {
  save(campaign: Campaign): Promise<void>;
  findById(id: CampaignId): Promise<Campaign | undefined>;
}
