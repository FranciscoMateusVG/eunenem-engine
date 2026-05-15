// --- Domain ---

// --- Adapter Interfaces (public contract — implement your own) ---
export type { CatRepository } from './adapters/cat-repository.js';
export type { Database } from './adapters/database.js';
// --- Database utilities ---
export { createDatabase } from './adapters/database.js';
export type { FeeRuleProvider } from './adapters/fee-rule-provider.js';
export { FeeRuleProviderMemory } from './adapters/fee-rule-provider.memory.js';
export type { FinancialLedgerRepository } from './adapters/financial-ledger-repository.js';
export { FinancialLedgerRepositoryMemory } from './adapters/financial-ledger-repository.memory.js';
export type { FundraisingCampaignRepository } from './adapters/fundraising-campaign-repository.js';
export { FundraisingCampaignRepositoryMemory } from './adapters/fundraising-campaign-repository.memory.js';
export type { FundraisingContributionRepository } from './adapters/fundraising-contribution-repository.js';
export { FundraisingContributionRepositoryMemory } from './adapters/fundraising-contribution-repository.memory.js';
export type { PaymentEventPublisher } from './adapters/payment-event-publisher.js';
export { PaymentEventPublisherMemory } from './adapters/payment-event-publisher.memory.js';
export { PaymentProviderFake } from './adapters/payment-provider.fake.js';
export type { PaymentProvider, RequestPaymentInput } from './adapters/payment-provider.js';
export type { PaymentRepository } from './adapters/payment-repository.js';
export { PaymentRepositoryMemory } from './adapters/payment-repository.memory.js';
export type { UserRepository } from './adapters/user-repository.js';
export { UserRepositoryMemory } from './adapters/user-repository.memory.js';
export type { UserSessionRepository } from './adapters/user-session-repository.js';
export { UserSessionRepositoryMemory } from './adapters/user-session-repository.memory.js';
export type { Cat, CatId, CatName, CreateCatInput } from './domain/cat.js';
export { CatIdSchema, CatNameSchema, CreateCatInputSchema } from './domain/cat.js';
export type {
  CalculateFeeCompositionInput,
  ContributionReferenceId,
  FeeCalculation,
  FeePayer,
  FeePercentageBps,
  FeeRule,
  ValueComposition,
} from './domain/fees.js';
export {
  CalculateFeeCompositionInputSchema,
  ContributionReferenceIdSchema,
  calculateFee,
  calculatePercentageFeeAmount,
  calculateValueComposition,
  composeValueComposition,
  DEFAULT_FEE_PERCENTAGE_BPS,
  DEFAULT_FEE_RULE,
  FeePayerSchema,
  FeePercentageBpsSchema,
  FeeRuleSchema,
} from './domain/fees.js';
export type {
  FinancialBalanceCents,
  FinancialContributionReferenceId,
  FinancialEntry,
  FinancialEntryId,
  FinancialEntryIds,
  FinancialEntryStatus,
  FinancialEntryType,
  FinancialFeePayer,
  FinancialPaymentReferenceId,
  FinancialPaymentStatus,
  FinancialPayoutId,
  FinancialReceiverId,
  FinancialValueCompositionSnapshot,
  GetReceiverFinancialBalanceInput,
  PayoutStatus,
  PlatformRevenue,
  ReceiverFinancialBalance,
  ReceiverPayout,
  RegisterApprovedPaymentFinancialEffectsInput,
  RequestReceiverPayoutInput,
} from './domain/financial.js';
export {
  assertApprovedPaymentFinancialComposition,
  calculatePlatformRevenue,
  calculateReceiverFinancialBalance,
  createFinancialEntriesForApprovedPayment,
  createRequestedReceiverPayout,
  FinancialBalanceCentsSchema,
  FinancialContributionReferenceIdSchema,
  FinancialEntryIdSchema,
  FinancialEntryIdsSchema,
  FinancialEntrySchema,
  FinancialEntryStatusSchema,
  FinancialEntryTypeSchema,
  FinancialFeePayerSchema,
  FinancialPaymentReferenceIdSchema,
  FinancialPaymentStatusSchema,
  FinancialPayoutIdSchema,
  FinancialReceiverIdSchema,
  FinancialValueCompositionSnapshotSchema,
  GetReceiverFinancialBalanceInputSchema,
  PayoutStatusSchema,
  PlatformRevenueSchema,
  ReceiverFinancialBalanceSchema,
  ReceiverPayoutSchema,
  RegisterApprovedPaymentFinancialEffectsInputSchema,
  RequestReceiverPayoutInputSchema,
} from './domain/financial.js';
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
export type {
  CreatePaymentIntentInput,
  CreatePendingPaymentInput,
  ExternalPaymentTransaction,
  ExternalPaymentTransactionStatus,
  ExternalTransactionId,
  Payment,
  PaymentCommandInput,
  PaymentContributionReferenceId,
  PaymentEvent,
  PaymentEventType,
  PaymentFeePayer,
  PaymentId,
  PaymentIntent,
  PaymentIntentId,
  PaymentMethod,
  PaymentProviderName,
  PaymentStatus,
  PaymentValueCompositionSnapshot,
} from './domain/payments.js';
export {
  approvePendingPayment,
  CreatePaymentIntentInputSchema,
  canApprovePayment,
  canRejectPayment,
  createPaymentEvent,
  createPendingPayment,
  ExternalPaymentTransactionSchema,
  ExternalPaymentTransactionStatusSchema,
  ExternalTransactionIdSchema,
  PaymentCommandInputSchema,
  PaymentContributionReferenceIdSchema,
  PaymentEventSchema,
  PaymentEventTypeSchema,
  PaymentFeePayerSchema,
  PaymentIdSchema,
  PaymentIntentIdSchema,
  PaymentIntentSchema,
  PaymentMethodSchema,
  PaymentProviderNameSchema,
  PaymentSchema,
  PaymentStatusSchema,
  PaymentValueCompositionSnapshotSchema,
  rejectPendingPayment,
} from './domain/payments.js';
export type {
  AuthorizeUserPermissionInput,
  CreateUserSessionInput,
  RegisterUserAccountInput,
  SimulatedUserCredential,
  UpdateUserProfileInput,
  User,
  UserAccount,
  UserAccountId,
  UserDisplayName,
  UserEmail,
  UserId,
  UserPermission,
  UserSession,
} from './domain/user.js';
export {
  AuthorizeUserPermissionInputSchema,
  CreateUserSessionInputSchema,
  DEFAULT_USER_PERMISSIONS,
  isUserSessionExpired,
  RegisterUserAccountInputSchema,
  SessionTokenSchema,
  SimulatedPasswordSchema,
  UpdateUserProfileInputSchema,
  UserAccountIdSchema,
  UserDisplayNameSchema,
  UserEmailSchema,
  UserIdSchema,
  UserPermissionSchema,
  userAccountHasPermission,
} from './domain/user.js';

// --- Errors ---
export { CatAlreadyExistsError } from './errors/cat-already-exists.error.js';
export { FeesInvalidInputError } from './errors/fees-invalid-input.error.js';
export { FinancialInsufficientAvailableBalanceError } from './errors/financial-insufficient-available-balance.error.js';
export { FinancialInvalidInputError } from './errors/financial-invalid-input.error.js';
export { FinancialPaymentAlreadyRecordedError } from './errors/financial-payment-already-recorded.error.js';
export { FinancialPaymentNotApprovedError } from './errors/financial-payment-not-approved.error.js';
export { FundraisingCampaignNotFoundError } from './errors/fundraising-campaign-not-found.error.js';
export { FundraisingContributionAlreadyExistsError } from './errors/fundraising-contribution-already-exists.error.js';
export { FundraisingContributionOptionNotFoundError } from './errors/fundraising-contribution-option-not-found.error.js';
export { FundraisingDuplicateOptionIdError } from './errors/fundraising-duplicate-option-id.error.js';
export { FundraisingInvalidInputError } from './errors/fundraising-invalid-input.error.js';
export { InvalidCatNameError } from './errors/invalid-cat-name.error.js';
export { PaymentAlreadyExistsError } from './errors/payment-already-exists.error.js';
export { PaymentAmountMismatchError } from './errors/payment-amount-mismatch.error.js';
export { PaymentInvalidStatusTransitionError } from './errors/payment-invalid-status-transition.error.js';
export { PaymentNotFoundError } from './errors/payment-not-found.error.js';
export { PaymentsInvalidInputError } from './errors/payments-invalid-input.error.js';
export { UserEmailAlreadyExistsError } from './errors/user-email-already-exists.error.js';
export { UserForbiddenError } from './errors/user-forbidden.error.js';
export { UserInvalidInputError } from './errors/user-invalid-input.error.js';
export { UserSessionInvalidError } from './errors/user-session-invalid.error.js';
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
export type { ApprovePaymentDeps } from './use-cases/approve-payment.js';
export { approvePayment } from './use-cases/approve-payment.js';
export type { AuthorizeUserPermissionDeps } from './use-cases/authorize-user-permission.js';
export { authorizeUserPermission } from './use-cases/authorize-user-permission.js';
export type { CalculateFeeCompositionDeps } from './use-cases/calculate-fee-composition.js';
export { calculateFeeComposition } from './use-cases/calculate-fee-composition.js';
export type { CreateCatDeps } from './use-cases/create-cat.js';
export { createCat } from './use-cases/create-cat.js';
export type { CreateFundraisingCampaignDeps } from './use-cases/create-fundraising-campaign.js';
export { createFundraisingCampaign } from './use-cases/create-fundraising-campaign.js';
export type { CreateFundraisingContributionDeps } from './use-cases/create-fundraising-contribution.js';
export { createFundraisingContribution } from './use-cases/create-fundraising-contribution.js';
export type { CreatePaymentIntentDeps } from './use-cases/create-payment-intent.js';
export { createPaymentIntent } from './use-cases/create-payment-intent.js';
export type { CreateUserSessionDeps } from './use-cases/create-user-session.js';
export { createUserSession } from './use-cases/create-user-session.js';
export type { GetPaymentByIdDeps } from './use-cases/get-payment-by-id.js';
export { getPaymentById } from './use-cases/get-payment-by-id.js';
export type { GetPlatformRevenueDeps } from './use-cases/get-platform-revenue.js';
export { getPlatformRevenue } from './use-cases/get-platform-revenue.js';
export type { GetReceiverFinancialBalanceDeps } from './use-cases/get-receiver-financial-balance.js';
export { getReceiverFinancialBalance } from './use-cases/get-receiver-financial-balance.js';
export type { RegisterApprovedPaymentFinancialEffectsDeps } from './use-cases/register-approved-payment-financial-effects.js';
export { registerApprovedPaymentFinancialEffects } from './use-cases/register-approved-payment-financial-effects.js';
export type {
  RegisterUserAccountDeps,
  RegisterUserAccountResult,
} from './use-cases/register-user-account.js';
export { registerUserAccount } from './use-cases/register-user-account.js';
export type { RejectPaymentDeps } from './use-cases/reject-payment.js';
export { rejectPayment } from './use-cases/reject-payment.js';
export type { RequestReceiverPayoutDeps } from './use-cases/request-receiver-payout.js';
export { requestReceiverPayout } from './use-cases/request-receiver-payout.js';
export type { UpdateUserProfileDeps } from './use-cases/update-user-profile.js';
export { updateUserProfile } from './use-cases/update-user-profile.js';
