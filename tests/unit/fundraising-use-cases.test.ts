import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FundraisingCampaignRepositoryMemory } from '../../src/adapters/fundraising-campaign-repository.memory.js';
import { FundraisingContributionRepositoryMemory } from '../../src/adapters/fundraising-contribution-repository.memory.js';
import { FundraisingCampaignNotFoundError } from '../../src/errors/fundraising-campaign-not-found.error.js';
import { FundraisingContributionAlreadyExistsError } from '../../src/errors/fundraising-contribution-already-exists.error.js';
import { FundraisingContributionOptionNotFoundError } from '../../src/errors/fundraising-contribution-option-not-found.error.js';
import { FundraisingDuplicateOptionIdError } from '../../src/errors/fundraising-duplicate-option-id.error.js';
import { FundraisingInvalidInputError } from '../../src/errors/fundraising-invalid-input.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { addFundraisingContributionOption } from '../../src/use-cases/add-fundraising-contribution-option.js';
import { createFundraisingCampaign } from '../../src/use-cases/create-fundraising-campaign.js';
import { createFundraisingContribution } from '../../src/use-cases/create-fundraising-contribution.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

describe('createFundraisingCampaign', () => {
  it('creates a campaign with no options', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const id = randomUUID();
    const creatorAccountId = randomUUID();
    const receiverId = randomUUID();

    const campaign = await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id,
        creatorAccountId,
        receiverId,
        title: 'Campanha teste',
      },
    );

    expect(campaign.id).toBe(id);
    expect(campaign.options).toEqual([]);
    expect(campaign.createdAt).toEqual(fixedDate);

    const loaded = await campaignRepository.findById(id);
    expect(loaded?.title).toBe('Campanha teste');
  });

  it('throws FundraisingInvalidInputError on bad title', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    await expect(
      createFundraisingCampaign(
        { campaignRepository, clock, observability: silentObservability },
        {
          id: randomUUID(),
          creatorAccountId: randomUUID(),
          receiverId: randomUUID(),
          title: '',
        },
      ),
    ).rejects.toThrow(FundraisingInvalidInputError);
  });
});

describe('addFundraisingContributionOption', () => {
  it('adds an option to an existing campaign', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const campaignId = randomUUID();
    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );

    const optionId = randomUUID();
    const updated = await addFundraisingContributionOption(
      { campaignRepository, observability: silentObservability },
      {
        campaignId,
        optionId,
        amountCents: 8000,
        label: 'R$ 80',
      },
    );

    expect(updated.options).toHaveLength(1);
    expect(updated.options[0]?.amountCents).toBe(8000);
    expect(updated.options[0]?.id).toBe(optionId);
  });

  it('throws when campaign is missing', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const missingId = randomUUID();
    await expect(
      addFundraisingContributionOption(
        { campaignRepository, observability: silentObservability },
        {
          campaignId: missingId,
          optionId: randomUUID(),
          amountCents: 100,
        },
      ),
    ).rejects.toThrow(FundraisingCampaignNotFoundError);
  });

  it('throws on duplicate option id on same campaign', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const campaignId = randomUUID();
    const optionId = randomUUID();
    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );
    await addFundraisingContributionOption(
      { campaignRepository, observability: silentObservability },
      { campaignId, optionId, amountCents: 100 },
    );
    await expect(
      addFundraisingContributionOption(
        { campaignRepository, observability: silentObservability },
        { campaignId, optionId, amountCents: 200 },
      ),
    ).rejects.toThrow(FundraisingDuplicateOptionIdError);
  });

  it('throws FundraisingInvalidInputError on invalid amount', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const campaignId = randomUUID();
    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );
    await expect(
      addFundraisingContributionOption(
        { campaignRepository, observability: silentObservability },
        { campaignId, optionId: randomUUID(), amountCents: 0 },
      ),
    ).rejects.toThrow(FundraisingInvalidInputError);
  });
});

describe('createFundraisingContribution', () => {
  it('creates contribution with amount from option', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const contributionRepository = new FundraisingContributionRepositoryMemory();
    const campaignId = randomUUID();
    const optionId = randomUUID();
    const contributionId = randomUUID();

    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );
    await addFundraisingContributionOption(
      { campaignRepository, observability: silentObservability },
      { campaignId, optionId, amountCents: 8000 },
    );

    const contribution = await createFundraisingContribution(
      {
        campaignRepository,
        contributionRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: contributionId,
        campaignId,
        contributionOptionId: optionId,
        contributor: { displayName: 'Visitante' },
      },
    );

    expect(contribution.amountCents).toBe(8000);
    expect(contribution.status).toBe('pending_payment');
    expect(contribution.contributionOptionId).toBe(optionId);
  });

  it('throws FundraisingInvalidInputError on invalid contributor', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const contributionRepository = new FundraisingContributionRepositoryMemory();

    await expect(
      createFundraisingContribution(
        {
          campaignRepository,
          contributionRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          campaignId: randomUUID(),
          contributionOptionId: randomUUID(),
          contributor: { displayName: '' },
        },
      ),
    ).rejects.toThrow(FundraisingInvalidInputError);
  });

  it('throws when campaign is missing', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const contributionRepository = new FundraisingContributionRepositoryMemory();
    const missingCampaign = randomUUID();

    await expect(
      createFundraisingContribution(
        {
          campaignRepository,
          contributionRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          campaignId: missingCampaign,
          contributionOptionId: randomUUID(),
          contributor: { displayName: 'X' },
        },
      ),
    ).rejects.toThrow(FundraisingCampaignNotFoundError);
  });

  it('throws when option not on campaign', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const contributionRepository = new FundraisingContributionRepositoryMemory();
    const campaignId = randomUUID();

    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );

    await expect(
      createFundraisingContribution(
        {
          campaignRepository,
          contributionRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          campaignId,
          contributionOptionId: randomUUID(),
          contributor: { displayName: 'X' },
        },
      ),
    ).rejects.toThrow(FundraisingContributionOptionNotFoundError);
  });

  it('throws when contribution id already exists', async () => {
    const campaignRepository = new FundraisingCampaignRepositoryMemory();
    const contributionRepository = new FundraisingContributionRepositoryMemory();
    const campaignId = randomUUID();
    const optionId = randomUUID();
    const contributionId = randomUUID();

    await createFundraisingCampaign(
      { campaignRepository, clock, observability: silentObservability },
      {
        id: campaignId,
        creatorAccountId: randomUUID(),
        receiverId: randomUUID(),
        title: 'Campanha',
      },
    );
    await addFundraisingContributionOption(
      { campaignRepository, observability: silentObservability },
      { campaignId, optionId, amountCents: 100 },
    );

    const deps = {
      campaignRepository,
      contributionRepository,
      clock,
      observability: silentObservability,
    };
    const input = {
      id: contributionId,
      campaignId,
      contributionOptionId: optionId,
      contributor: { displayName: 'A' },
    };

    await createFundraisingContribution(deps, input);
    await expect(createFundraisingContribution(deps, input)).rejects.toThrow(
      FundraisingContributionAlreadyExistsError,
    );
  });
});
