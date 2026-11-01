import type { CartLine } from './cart.js';
import type { CartQuote } from './paginaApi.js';

/** Reconcile by persistent ids, not mutable names. Never substitute an unrelated gift. */
export function reconcileCart(lines: readonly CartLine[], quote: CartQuote) {
  const next: CartLine[] = [];
  const notices = new Set<string>();
  for (const line of lines) {
    const rows = quote.itens.filter((row) => line.idsAvailable.includes(row.idContribuicao));
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = JSON.stringify([row.nome, row.valorCents, row.valorComTaxaCartaoCents]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    let quantidade = 0;
    for (const group of groups.values()) {
      const first = group[0];
      const selected = group.reduce((n, r) => n + r.quantidade, 0);
      if (!first || !selected) continue;
      quantidade += selected;
      if (first.valorCents !== line.valorCents || first.valorComTaxaCartaoCents !== line.valorComTaxaCartaoCents) {
        notices.add(`O preço de ${line.nome} mudou. Confira o total atualizado.`);
      }
      next.push({ ...line, nome: first.nome, cartKey: group.map((r) => r.idContribuicao).join(','),
        idsAvailable: group.map((r) => r.idContribuicao), quantidade: selected,
        qtyAvailable: group.reduce((n, r) => n + r.qtyAvailable, 0),
        valorCents: first.valorCents, valorComTaxaCartaoCents: first.valorComTaxaCartaoCents,
        imagemUrl: first.imagemUrl });
    }
    if (quantidade < line.quantidade) notices.add(quantidade === 0
      ? `${line.nome} não está mais disponível e saiu do carrinho.`
      : `A quantidade disponível de ${line.nome} mudou. Confira o carrinho.`);
  }
  return { lines: next, notices: [...notices] };
}
