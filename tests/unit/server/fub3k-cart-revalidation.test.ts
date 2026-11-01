import { describe, expect, it } from 'vitest';
import {
  type CartLine,
  cartReducer,
  sameCheckoutRequest,
  toSagaInput,
} from '../../../apps/eunenem-server/pages/lib/cart.js';
import { reconcileCart } from '../../../apps/eunenem-server/pages/lib/cart-revalidation.js';

const line: CartLine = {
  nome: 'Mimo',
  idsAvailable: ['a', 'b'],
  quantidade: 2,
  qtyAvailable: 2,
  valorCents: 1090,
  valorComTaxaCartaoCents: 1172,
  imagemUrl: null,
  emoji: '🎁',
  bgColor: '#fff',
  displayCategory: 'outros',
  grupoKey: 'outros',
};
function row(id: string, valorCents = 1090, quantidade = 1) {
  return {
    idContribuicao: id,
    nome: 'Mimo',
    quantidade,
    qtyAvailable: 1,
    valorCents,
    valorComTaxaCartaoCents: valorCents + 82,
    imagemUrl: null,
  };
}
function quote(itens: ReturnType<typeof row>[]) {
  return { itens, totalPixCents: 0, totalCartaoCents: 0 };
}

describe('cart reconciliation by persistent gift ids', () => {
  it('splits differently priced legacy rows without losing names or charging the first price for both', () => {
    const result = reconcileCart([line], quote([row('a'), row('b', 2180)]));
    expect(result.lines.map((l) => l.valorCents)).toEqual([1090, 2180]);
    expect(result.notices.join(' ')).toContain('preço de Mimo mudou');
    expect(toSagaInput(result.lines)).toEqual([
      { idContribuicao: 'a', quantidade: 1 },
      { idContribuicao: 'b', quantidade: 1 },
    ]);
    const key = result.lines[0]?.cartKey;
    if (!key) throw new Error('missing line key');
    const next = cartReducer({ slug: 'test', lines: result.lines }, { type: 'remove', nome: key });
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0]?.idsAvailable).toEqual(['b']);
  });
  it('removes unavailable/archived rows and warns about quantity changes', () => {
    const partial = reconcileCart([line], quote([row('b')]));
    expect(partial.lines[0]?.quantidade).toBe(1);
    expect(partial.notices.join(' ')).toContain('quantidade disponível');
    const removed = reconcileCart([line], quote([]));
    expect(removed.lines).toEqual([]);
    expect(removed.notices.join(' ')).toContain('saiu do carrinho');
  });
  it('retains unselected legacy capacity without charging it', () => {
    const result = reconcileCart(
      [{ ...line, quantidade: 1 }],
      quote([row('a'), row('b', 1090, 0)]),
    );
    expect(result.lines[0]).toMatchObject({
      quantidade: 1,
      qtyAvailable: 2,
      idsAvailable: ['a', 'b'],
    });
    expect(result.notices).toEqual([]);
  });
  it('marketplace name controls change only one revalidated price group', () => {
    const split = reconcileCart(
      [line],
      quote([row('a'), { ...row('b', 2180), qtyAvailable: 3 }]),
    ).lines;
    const initial = { slug: 'test', lines: split };
    const incremented = cartReducer(initial, { type: 'increment', nome: 'Mimo' });
    expect(incremented.lines.map((l) => l.quantidade)).toEqual([1, 2]);
    const decremented = cartReducer(incremented, {
      type: 'decrement',
      nome: split[1]?.cartKey ?? '',
    });
    expect(decremented.lines.map((l) => l.quantidade)).toEqual([1, 1]);
  });
  it('invalidates an old checkout when only the price changes', () => {
    expect(sameCheckoutRequest([line], [{ ...line, valorCents: 2180 }])).toBe(false);
  });
});
