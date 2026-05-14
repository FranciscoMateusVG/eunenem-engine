import type { ContributionOptionId } from '../domain/fundraising-campaign.js';

export class FundraisingDuplicateOptionIdError extends Error {
  public readonly code = 'FUNDRAISING_DUPLICATE_OPTION_ID' as const;

  constructor(public readonly optionId: ContributionOptionId) {
    super(`A contribution option with id "${optionId}" already exists on this campaign.`);
    this.name = 'FundraisingDuplicateOptionIdError';
  }
}
