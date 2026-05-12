import type { ContributionId } from '../domain/fundraising-contribution.js';

export class FundraisingContributionAlreadyExistsError extends Error {
  public readonly code = 'FUNDRAISING_CONTRIBUTION_ALREADY_EXISTS' as const;

  constructor(public readonly contributionId: ContributionId) {
    super(`A contribution with id "${contributionId}" already exists.`);
    this.name = 'FundraisingContributionAlreadyExistsError';
  }
}
