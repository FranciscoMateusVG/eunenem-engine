/**
 * Stable lock acquisition order shared by in-memory and PostgreSQL adapters.
 * Keeping this pure avoids coupling the memory adapter to Kysely/sql imports.
 */
export function sortUniquePaymentIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
