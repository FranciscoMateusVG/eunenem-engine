// aperture-dikki — shared BRL formatter for the visitor surfaces.
//
// Single source of truth for cents → "R$ X,YZ" formatting. Previously
// duplicated as an inline helper in GiftCheckoutModal and a hotfix
// duplicate in GiftCard (added when the fee-inclusive projection in
// aperture-ines9 shipped non-integer prices and Math.round-to-int started
// truncating cents — "R$ 1" instead of "R$ 1,05").
//
// Uses Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
// for the production-quality formatting — handles thousands separators
// (R$ 1.234,56), correct comma decimal, and the non-breaking-space-after-
// R$ that Brazilian convention prefers. Cached at module level because
// Intl.NumberFormat instantiation is non-trivial (locale data lookup +
// format-rule compilation); reusing the instance keeps the per-render
// cost negligible.

const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/** Format integer cents as a BRL string. 100 → "R$ 1,00", 105 → "R$ 1,05",
 *  100000 → "R$ 1.000,00". Handles zero + negative values gracefully. */
export function formatBRL(cents: number): string {
  return BRL_FORMATTER.format(cents / 100);
}
