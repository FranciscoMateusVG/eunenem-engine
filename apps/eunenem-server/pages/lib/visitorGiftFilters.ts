import type { VisitorGift } from './visitorGift.js';

export type GiftSort = 'default' | 'name' | 'price-asc' | 'price-desc';

type SearchableGift = Pick<VisitorGift, 'nome' | 'grupoKey' | 'displayCategory' | 'valorCents'>;

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

function priceInCents(value: string): number | null {
  if (!value.trim()) return null;
  const price = Number(value.replace(',', '.'));
  return Number.isFinite(price) && price >= 0 ? Math.round(price * 100) : null;
}

export function filterVisitorGifts<T extends SearchableGift>(
  gifts: readonly T[],
  filters: { search: string; minPrice: string; maxPrice: string; sort: GiftSort },
): T[] {
  const terms = normalize(filters.search).trim().split(/\s+/).filter(Boolean);
  const min = priceInCents(filters.minPrice);
  const max = priceInCents(filters.maxPrice);
  const result = gifts.filter((gift) => {
    const text = normalize(`${gift.nome} ${gift.grupoKey} ${gift.displayCategory}`);
    return terms.every((term) => text.includes(term)) &&
      (min === null || gift.valorCents >= min) &&
      (max === null || gift.valorCents <= max);
  });
  if (filters.sort === 'name') {
    result.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
  } else if (filters.sort === 'price-asc' || filters.sort === 'price-desc') {
    const direction = filters.sort === 'price-asc' ? 1 : -1;
    result.sort((a, b) => direction * (a.valorCents - b.valorCents));
  }
  return result;
}
