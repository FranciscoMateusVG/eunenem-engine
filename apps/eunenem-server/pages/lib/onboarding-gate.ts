/**
 * aperture-8ysqu — server-authoritative onboarding gate.
 *
 * `needsOnboarding` is exposed on auth.me by the backend (Rex): true for an
 * account that has not completed signup-onboarding (e.g. an OAuth-provisioned
 * row with nomeBebe / dataEvento still null), false once onboarded. This is the
 * authoritative, PROVIDER-AGNOSTIC gate — it replaces the brittle client-only
 * `criado` flag the email flow used, so Google / Microsoft / any future OAuth
 * signup all reach the onboarding wizard (the email flow keeps `criado` as its
 * in-modal fast-path; this is the catch-all everywhere else).
 *
 * Defensive read: anything other than a literal `true` (missing field, false,
 * non-boolean) means "no onboarding needed". So this is safe BEFORE the backend
 * field lands — it simply no-ops — and continues to work once it does.
 */
export function needsOnboarding(me: unknown): boolean {
  return (
    typeof me === "object" &&
    me !== null &&
    (me as { needsOnboarding?: unknown }).needsOnboarding === true
  );
}

/**
 * aperture-duk6x — server-authoritative legacy gate (field lands via Rex's
 * parallel PR; coordinated name: `isLegacy`, boolean, true when the caller's
 * email matches legacy-1.0-users.json). Legacy users OUTRANK the onboarding
 * wizard in post-login routing: they're migrating from 1.0 — /campanhas (the
 * migration hub with their 1.0 card) is their front door, even while their
 * 2.0 profile is un-onboarded.
 *
 * Same defensive-read contract as needsOnboarding above: anything other than
 * a literal `true` means "not legacy", so this no-ops safely until the
 * backend field ships and keeps working after.
 */
export function isLegacy(me: unknown): boolean {
  return (
    typeof me === "object" &&
    me !== null &&
    (me as { isLegacy?: unknown }).isLegacy === true
  );
}
