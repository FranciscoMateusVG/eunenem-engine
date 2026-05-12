import { z } from 'zod/v4';
import type { CampaignId, ContributionOptionId } from './fundraising-campaign.js';
import { CampaignIdSchema, ContributionOptionIdSchema } from './fundraising-campaign.js';
import type { MoneyCents } from './money.js';

/**
 * **Contribuição** (BC Arrecadação): vínculo entre visitante, campanha e opção escolhida.
 * O valor em centavos é copiado da opção no momento da criação (imutável face a mudanças futuras na campanha).
 */
export const ContributionIdSchema = z.uuid();
export type ContributionId = z.infer<typeof ContributionIdSchema>;

export const ContributorDisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name must not be empty')
  .max(120);

export const ContributorProfileSchema = z.object({
  displayName: ContributorDisplayNameSchema,
  email: z.string().trim().email().max(320).optional(),
});

export type ContributorProfile = Readonly<z.infer<typeof ContributorProfileSchema>>;

export type ContributionStatus = 'pending_payment';

export interface Contribution {
  readonly id: ContributionId;
  readonly campaignId: CampaignId;
  readonly contributionOptionId: ContributionOptionId;
  readonly amountCents: MoneyCents;
  readonly contributor: ContributorProfile;
  readonly status: ContributionStatus;
  readonly createdAt: Date;
}

export const CreateFundraisingContributionInputSchema = z.object({
  id: ContributionIdSchema,
  campaignId: CampaignIdSchema,
  contributionOptionId: ContributionOptionIdSchema,
  contributor: ContributorProfileSchema,
});

export type CreateFundraisingContributionInput = z.infer<
  typeof CreateFundraisingContributionInputSchema
>;
