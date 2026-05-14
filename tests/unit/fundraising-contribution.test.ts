import { describe, expect, it } from 'vitest';
import { CreateFundraisingContributionInputSchema } from '../../src/domain/fundraising-contribution.js';

const contributionId = '550e8400-e29b-41d4-a716-446655440010';
const campaignId = '550e8400-e29b-41d4-a716-446655440011';
const optionId = '550e8400-e29b-41d4-a716-446655440012';

describe('CreateFundraisingContributionInputSchema', () => {
  it('accepts valid contributor', () => {
    const r = CreateFundraisingContributionInputSchema.safeParse({
      id: contributionId,
      campaignId,
      contributionOptionId: optionId,
      contributor: { displayName: 'Ana' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts optional email', () => {
    const r = CreateFundraisingContributionInputSchema.safeParse({
      id: contributionId,
      campaignId,
      contributionOptionId: optionId,
      contributor: { displayName: 'Ana', email: 'ana@example.com' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid email', () => {
    const r = CreateFundraisingContributionInputSchema.safeParse({
      id: contributionId,
      campaignId,
      contributionOptionId: optionId,
      contributor: { displayName: 'Ana', email: 'not-an-email' },
    });
    expect(r.success).toBe(false);
  });
});
