import { describe, expect, it } from 'vitest';
import { filterVisitorGifts } from '../../../apps/eunenem-server/pages/lib/visitorGiftFilters.js';

const gifts = [
  { nome: 'Zebra', grupoKey: 'brinquedo', displayCategory: 'Brincar', valorCents: 8599 },
  { nome: 'Álcool de bebê', grupoKey: 'higiene', displayCategory: 'Higiene', valorCents: 1090 },
  { nome: 'Body calor', grupoKey: 'roupa', displayCategory: 'Roupinha', valorCents: 2500 },
];
const defaults = { search: '', minPrice: '', maxPrice: '', sort: 'default' as const };

describe('public gift filters', () => {
  it('searches names and types without case or accent sensitivity', () => {
    expect(filterVisitorGifts(gifts, { ...defaults, search: ' ALCOOL bebe ' })).toEqual([gifts[1]]);
    expect(filterVisitorGifts(gifts, { ...defaults, search: 'ROUPA' })).toEqual([gifts[2]]);
    expect(filterVisitorGifts(gifts, { ...defaults, search: 'brincar' })).toEqual([gifts[0]]);
  });
  it('combines search with inclusive price bounds in reais, preserving cents', () => {
    expect(filterVisitorGifts(gifts, { ...defaults, minPrice: '10,90', maxPrice: '25' })).toEqual(
      gifts.slice(1),
    );
    expect(filterVisitorGifts(gifts, { ...defaults, search: 'roupa', maxPrice: '24.99' })).toEqual(
      [],
    );
    expect(filterVisitorGifts(gifts, { ...defaults, minPrice: '85.99' })).toEqual([gifts[0]]);
    expect(filterVisitorGifts(gifts, { ...defaults, minPrice: '50', maxPrice: '10' })).toEqual([]);
  });
  it('sorts alphabetically and numerically without mutating the original list', () => {
    expect(filterVisitorGifts(gifts, { ...defaults, sort: 'name' })).toEqual([
      gifts[1],
      gifts[2],
      gifts[0],
    ]);
    expect(filterVisitorGifts(gifts, { ...defaults, sort: 'price-asc' })).toEqual([
      gifts[1],
      gifts[2],
      gifts[0],
    ]);
    expect(filterVisitorGifts(gifts, { ...defaults, sort: 'price-desc' })).toEqual([
      gifts[0],
      gifts[2],
      gifts[1],
    ]);
    expect(filterVisitorGifts(gifts, defaults)).toEqual(gifts);
    expect(gifts[0].nome).toBe('Zebra');
  });
  it('handles no results and empty lists', () => {
    expect(filterVisitorGifts(gifts, { ...defaults, search: 'inexistente' })).toEqual([]);
    expect(filterVisitorGifts([], defaults)).toEqual([]);
  });
});
