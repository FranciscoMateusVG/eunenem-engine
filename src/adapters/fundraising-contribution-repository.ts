import type { Contribution, ContributionId } from '../domain/fundraising-contribution.js';

/**
 * Persistência de Contribuições (porta).
 */
export interface FundraisingContributionRepository {
  save(contribution: Contribution): Promise<void>;
  findById(id: ContributionId): Promise<Contribution | undefined>;
}
