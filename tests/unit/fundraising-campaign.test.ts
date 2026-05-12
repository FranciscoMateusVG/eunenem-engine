import { describe, expect, it } from 'vitest';
import {
  CreateFundraisingCampaignInputSchema,
  campaignWithOption,
  findContributionOption,
} from '../../src/domain/fundraising-campaign.js';

const campaignId = '550e8400-e29b-41d4-a716-446655440001';
const creatorId = '550e8400-e29b-41d4-a716-446655440002';
const receiverId = '550e8400-e29b-41d4-a716-446655440003';
const optionId = '550e8400-e29b-41d4-a716-446655440004';

describe('CreateFundraisingCampaignInputSchema', () => {
  it('accepts valid input', () => {
    const r = CreateFundraisingCampaignInputSchema.safeParse({
      id: campaignId,
      creatorAccountId: creatorId,
      receiverId,
      title: 'Ajuda ao João',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty title', () => {
    const r = CreateFundraisingCampaignInputSchema.safeParse({
      id: campaignId,
      creatorAccountId: creatorId,
      receiverId,
      title: '   ',
    });
    expect(r.success).toBe(false);
  });
});

describe('findContributionOption', () => {
  it('returns the option when present', () => {
    const option = { id: optionId, amountCents: 8000, label: 'Valor sugerido' };
    const campaign = {
      id: campaignId,
      creatorAccountId: creatorId,
      receiverId,
      title: 'Campanha',
      options: [option],
      createdAt: new Date(),
    };
    expect(findContributionOption(campaign, optionId)).toEqual(option);
  });

  it('returns undefined when missing', () => {
    const campaign = {
      id: campaignId,
      creatorAccountId: creatorId,
      receiverId,
      title: 'Campanha',
      options: [],
      createdAt: new Date(),
    };
    expect(findContributionOption(campaign, optionId)).toBeUndefined();
  });
});

describe('campaignWithOption', () => {
  it('appends option immutably', () => {
    const base = {
      id: campaignId,
      creatorAccountId: creatorId,
      receiverId,
      title: 'Campanha',
      options: [] as const,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const opt = { id: optionId, amountCents: 5000 };
    const next = campaignWithOption(base, opt);
    expect(base.options).toHaveLength(0);
    expect(next.options).toHaveLength(1);
    expect(next.options[0]).toEqual(opt);
  });
});
