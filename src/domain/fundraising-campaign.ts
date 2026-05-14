import { z } from 'zod/v4';
import { MoneyCentsSchema } from './money.js';

/**
 * Agregado **Campanha** (BC Arrecadação): raiz que agrupa opções de contribuição.
 * Criador e recebedor são referências por ID (sem entidades de Identidade aqui).
 */
export const AccountIdSchema = z.uuid();
export type AccountId = z.infer<typeof AccountIdSchema>;

export const ReceiverIdSchema = z.uuid();
export type ReceiverId = z.infer<typeof ReceiverIdSchema>;

export const CampaignIdSchema = z.uuid();
export type CampaignId = z.infer<typeof CampaignIdSchema>;

export const ContributionOptionIdSchema = z.uuid();
export type ContributionOptionId = z.infer<typeof ContributionOptionIdSchema>;

export const ContributionOptionSchema = z.object({
  id: ContributionOptionIdSchema,
  amountCents: MoneyCentsSchema,
  label: z.string().trim().max(200).optional(),
});

export type ContributionOption = Readonly<z.infer<typeof ContributionOptionSchema>>;

export interface Campaign {
  readonly id: CampaignId;
  readonly creatorAccountId: AccountId;
  readonly receiverId: ReceiverId;
  readonly title: string;
  readonly options: readonly ContributionOption[];
  readonly createdAt: Date;
}

export const CreateFundraisingCampaignInputSchema = z.object({
  id: CampaignIdSchema,
  creatorAccountId: AccountIdSchema,
  receiverId: ReceiverIdSchema,
  title: z.string().trim().min(1, 'Title must not be empty').max(200),
});

export type CreateFundraisingCampaignInput = z.infer<typeof CreateFundraisingCampaignInputSchema>;

export const AddFundraisingContributionOptionInputSchema = z.object({
  campaignId: CampaignIdSchema,
  optionId: ContributionOptionIdSchema,
  amountCents: MoneyCentsSchema,
  label: z.string().trim().max(200).optional(),
});

export type AddFundraisingContributionOptionInput = z.infer<
  typeof AddFundraisingContributionOptionInputSchema
>;

/** Procura uma opção de contribuição na campanha (regra pura de domínio). */
export function findContributionOption(
  campaign: Campaign,
  optionId: ContributionOptionId,
): ContributionOption | undefined {
  return campaign.options.find((o) => o.id === optionId);
}

/** Anexa uma opção, imutavelmente. O use case deve garantir ausência de duplicados de `option.id`. */
export function campaignWithOption(campaign: Campaign, option: ContributionOption): Campaign {
  return {
    ...campaign,
    options: [...campaign.options, option],
  };
}
