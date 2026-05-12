// --- Domain ---

// --- Adapter Interfaces (public contract — implement your own) ---
export type { CatRepository } from './adapters/cat-repository.js';
export type { Database } from './adapters/database.js';
// --- Database utilities ---
export { createDatabase } from './adapters/database.js';
export type { FundraisingCampaignRepository } from './adapters/fundraising-campaign-repository.js';
export { FundraisingCampaignRepositoryMemory } from './adapters/fundraising-campaign-repository.memory.js';
export type { FundraisingContributionRepository } from './adapters/fundraising-contribution-repository.js';
export { FundraisingContributionRepositoryMemory } from './adapters/fundraising-contribution-repository.memory.js';
export type { Cat, CatId, CatName, CreateCatInput } from './domain/cat.js';
export { CatIdSchema, CatNameSchema, CreateCatInputSchema } from './domain/cat.js';
export type {
  AccountId,
  AddFundraisingContributionOptionInput,
  Campaign,
  CampaignId,
  ContributionOption,
  ContributionOptionId,
  CreateFundraisingCampaignInput,
  ReceiverId,
} from './domain/fundraising-campaign.js';
export {
  AccountIdSchema,
  AddFundraisingContributionOptionInputSchema,
  CampaignIdSchema,
  ContributionOptionIdSchema,
  CreateFundraisingCampaignInputSchema,
  findContributionOption,
  ReceiverIdSchema,
} from './domain/fundraising-campaign.js';
export type {
  Contribution,
  ContributionId,
  ContributorProfile,
  CreateFundraisingContributionInput,
} from './domain/fundraising-contribution.js';
export {
  ContributionIdSchema,
  ContributorProfileSchema,
  CreateFundraisingContributionInputSchema,
} from './domain/fundraising-contribution.js';
export type { MoneyCents } from './domain/money.js';
export { MoneyCentsSchema } from './domain/money.js';

// --- Errors ---
export { CatAlreadyExistsError } from './errors/cat-already-exists.error.js';
export { FundraisingCampaignNotFoundError } from './errors/fundraising-campaign-not-found.error.js';
export { FundraisingContributionAlreadyExistsError } from './errors/fundraising-contribution-already-exists.error.js';
export { FundraisingContributionOptionNotFoundError } from './errors/fundraising-contribution-option-not-found.error.js';
export { FundraisingDuplicateOptionIdError } from './errors/fundraising-duplicate-option-id.error.js';
export { FundraisingInvalidInputError } from './errors/fundraising-invalid-input.error.js';
export { InvalidCatNameError } from './errors/invalid-cat-name.error.js';
export { ConsoleLogger } from './observability/console-logger.js';
// --- Observability ---
export type { Logger } from './observability/logger.js';
export { NoopLogger } from './observability/noop-logger.js';
export type { Observability } from './observability/observability.js';
export { OtelLogger } from './observability/otel-logger.js';
export type { Span, Tracer } from './observability/tracer.js';
export { noopTracer, SpanKind, SpanStatusCode, trace } from './observability/tracer.js';
// --- Use Cases ---
export type { AddFundraisingContributionOptionDeps } from './use-cases/add-fundraising-contribution-option.js';
export { addFundraisingContributionOption } from './use-cases/add-fundraising-contribution-option.js';
export type { CreateCatDeps } from './use-cases/create-cat.js';
export { createCat } from './use-cases/create-cat.js';
export type { CreateFundraisingCampaignDeps } from './use-cases/create-fundraising-campaign.js';
export { createFundraisingCampaign } from './use-cases/create-fundraising-campaign.js';
export type { CreateFundraisingContributionDeps } from './use-cases/create-fundraising-contribution.js';
export { createFundraisingContribution } from './use-cases/create-fundraising-contribution.js';
