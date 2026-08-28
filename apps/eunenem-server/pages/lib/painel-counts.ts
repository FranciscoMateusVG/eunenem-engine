export type PainelCountSummary = {
  totalPresentes: number;
  totalPresentesItensCount?: number;
};

export type PainelCountGuest = {
  presenca: 'nao_enviado' | 'enviado' | 'sim' | 'talvez' | 'nao';
};

/**
 * Normalises the dashboard counters before they reach individual cards.
 *
 * A pagamento can contain more than one gift item. The painel previously used
 * distinct pagamentos in the "presentes recebidos" row and item count in the
 * header strip, so the same purchase produced two different visible totals.
 * Prefer the item count everywhere; the pagamento count is only a backwards-
 * compatible fallback for an older summary payload.
 */
export function derivePainelCounts(input: {
  summary: PainelCountSummary | null | undefined;
  guests: readonly PainelCountGuest[] | null | undefined;
}) {
  const giftsReceived =
    input.summary?.totalPresentesItensCount ?? input.summary?.totalPresentes ?? 0;
  const guests = input.guests ?? [];

  return {
    giftsReceived,
    guestsTotal: guests.length,
    guestsConfirmed: guests.filter((guest) => guest.presenca === 'sim').length,
  };
}
