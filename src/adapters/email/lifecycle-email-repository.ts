import type { LifecycleEmailType } from './lifecycle-email-preferences.js';
export interface LifecycleEmailVars {
  recipientName: string;
  ownerName: string;
  dashboardUrl: string;
  preferencesUrl: string;
  unsubscribeUrl: string;
  feedbackUrl: string;
  assetBaseUrl: string;
  startUrl: string;
  shareUrl: string;
  giftCount: number | null;
  eventDate?: string;
  guestName?: string;
  guestMessage?: string;
  gifts: { name: string; quantity: number }[];
  recipientIsOwner: boolean;
}
export interface Recipient {
  user_id: string;
  tenant_id: string;
  email: string;
  name: string;
  slug: string;
  owner: boolean;
}
export interface Snapshot {
  guestName?: string;
  guestMessage?: string;
  gifts?: { name: string; quantity: number }[];
  eventDate?: string;
}
export interface Event {
  id: string;
  tenant_id: string;
  type: LifecycleEmailType;
  subject_id: string;
  campaign_id: string | null;
  snapshot: Snapshot;
}
export interface Delivery extends Event {
  delivery_id: string;
  user_id: string;
  attempts: number;
}
export interface LifecycleEmailConfig {
  enabled: boolean;
  launchAt: Date | null;
  origin: string;
  enabledTypes?: readonly LifecycleEmailType[];
  recipientAllowlist?: readonly string[];
  /** Explicit override of recipient allowlist only; all other eligibility gates remain. */
  allowAllRecipients?: boolean;
}

/** "seu chá já está pronto!" waits this long after the campaign's first gift. */
export const LIST_READY_DELAY_MS = 24 * 60 * 60_000;
export interface LifecycleCandidates {
  welcomes: { id: string; created_at: Date }[];
  /** First-gift facts at least LIST_READY_DELAY_MS old. */
  gifts: { campaign_id: string; occurred_at: Date }[];
  reminders: { id_campanha: string; event_date: string }[];
  payments: { id: string }[];
  /** Approved payments carrying a recado whose owner alert was never admitted. */
  messages: { id: string }[];
}
export interface LifecycleEmailRepository {
  initialize(launchAt: Date, now: Date): Promise<void>;
  provisioningStarted(userId: string, campaignId: string, giftCount: number): Promise<void>;
  provisioningCompleted(
    userId: string,
    campaignId: string,
    giftCount: number,
    now: Date,
  ): Promise<void>;
  recipients(
    launchAt: Date,
    campaignId: string | null,
    userId?: string,
    ownerOnly?: boolean,
  ): Promise<Recipient[]>;
  admit(
    launchAt: Date,
    now: Date,
    type: LifecycleEmailType,
    subjectId: string,
    campaignId: string | null,
    occurredAt: Date,
    snapshot: Snapshot,
    ownerOnly: boolean,
    userId?: string,
  ): Promise<void>;
  paymentGifts(paymentId: string): Promise<{ name: string; quantity: number }[]>;
  recoverProvisioning(now: Date): Promise<void>;
  recoverStale(now: Date): Promise<number>;
  candidates(launchAt: Date, now: Date): Promise<LifecycleCandidates>;
  claim(now: Date): Promise<Delivery | undefined>;
  finish(id: string, state: string, reason: string, now: Date): Promise<void>;
  reminderStillDue(campaignId: string | null, eventDate: string, now: Date): Promise<boolean>;
  /** The guest belongs to the campaign's guest list and still answers "sim". */
  presenceStillConfirmed(campaignId: string | null, guestId: string): Promise<boolean>;
  giftCount(campaignId: string | null): Promise<number | null>;
  ownerName(campaignId: string | null): Promise<string | null>;
  reserveEmail(eventId: string, deliveryId: string, emailKey: string): Promise<boolean>;
  retry(id: string, nextAttempt: Date): Promise<void>;
}
