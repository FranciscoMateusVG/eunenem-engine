/**
 * aperture-gu7u6 — a pending checkout screen is valid only for the cart that
 * generated it. sameCheckoutRequest compares what the cart would SEND
 * (saga items), so any item/quantity change invalidates it.
 */
import { describe, expect, it } from 'vitest';
import { type CartLine, sameCheckoutRequest } from '../../../apps/eunenem-server/pages/lib/cart.js';

function line(nome: string, quantidade: number, ids: string[] = [`id-${nome}`]): CartLine {
  return {
    nome,
    idsAvailable: ids,
    qtyAvailable: 5,
    quantidade,
    valorCents: 1090,
    valorComTaxaCartaoCents: null,
    imagemUrl: null,
    emoji: '🎁',
    bgColor: '#fff',
    displayCategory: 'outros',
    grupoKey: nome,
  };
}

describe('sameCheckoutRequest', () => {
  it('is true for an unchanged cart', () => {
    expect(sameCheckoutRequest([line('a', 1)], [line('a', 1)])).toBe(true);
  });

  it('is false when an item is added', () => {
    expect(sameCheckoutRequest([line('a', 1)], [line('a', 1), line('b', 1)])).toBe(false);
  });

  it('is false when a quantity changes', () => {
    expect(sameCheckoutRequest([line('a', 1)], [line('a', 2)])).toBe(false);
  });

  it('is false when an item is removed', () => {
    expect(sameCheckoutRequest([line('a', 1), line('b', 1)], [line('a', 1)])).toBe(false);
  });
});
