export const LIFECYCLE_EMAIL_TYPES = [
  'welcome',
  'list_ready',
  'event_reminder',
  'payment_received',
  'new_message',
  'presence_confirmed',
] as const;
export type LifecycleEmailType = (typeof LIFECYCLE_EMAIL_TYPES)[number];
export type LifecycleEmailPreferences = Record<
  Exclude<LifecycleEmailType, 'new_message' | 'presence_confirmed'>,
  boolean
> &
  Partial<Record<'new_message' | 'presence_confirmed', boolean>>;

export interface LifecycleEmailPreferencesRepository {
  getPreferences(userId: string, tenantId: string): Promise<LifecycleEmailPreferences>;
  setPreferences(
    userId: string,
    tenantId: string,
    patch: Partial<LifecycleEmailPreferences>,
  ): Promise<void>;
}
