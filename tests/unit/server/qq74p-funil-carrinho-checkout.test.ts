/**
 * aperture-qq74p — Tier 2 cart/checkout funnel events, bounded.
 *
 * Honest scope (node env, no DOM): every event is derived from a REAL state
 * transition and this file proves exactly that — cart deltas against the
 * REAL cart reducer (cap/esgotado no-ops emit nothing; clear emits nothing),
 * carrinho_aberto only on closed→open, checkout_falhou with a finite tRPC
 * code (never the message), pagamento_falhou(pix) only for a SERVER-reported
 * terminal status (local countdown → nothing). Source pins keep the call
 * sites honest. NOT proven: rendering, real browser behaviour, delivery or
 * ingestion on either sink (best-effort analytics).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CelulaEstado,
  codigoErroTrpc,
  deltaLinhaCarrinho,
  despacharComDelta,
  emitirCarrinhoAberto,
  emitirCheckoutFalhou,
  emitirDeltaCarrinho,
  emitirPixFalhou,
  motivoPixFalhou,
} from '../../../apps/eunenem-server/pages/lib/analytics-funil.js';
import { cartReducer } from '../../../apps/eunenem-server/pages/lib/cart.js';
import type { VisitorGift } from '../../../apps/eunenem-server/pages/lib/visitorGift.js';

function coletor() {
  const emitidos: Array<{ nome: string; props: Record<string, unknown> }> = [];
  return {
    emitidos,
    emitir: (nome: string, props: Record<string, unknown>) => {
      emitidos.push({ nome, props });
    },
  };
}

// Minimal VisitorGift for the reducer — only the fields `add` reads.
const gift = (nome: string, qtyAvailable: number, valorCents = 5000): VisitorGift =>
  ({
    nome,
    availableIds: qtyAvailable > 0 ? ['id-1'] : [],
    qtyAvailable,
    valorCents,
    valorComTaxaCartaoCents: valorCents + 300,
    imagemUrl: null,
    emoji: null,
    bgColor: null,
    displayCategory: 'x',
    grupoKey: 'g',
  }) as unknown as VisitorGift;

type S = Parameters<typeof cartReducer>[0];
const vazio: S = { slug: 's', lines: [] };

describe('cart deltas — derived from the REAL reducer transition', () => {
  it('add to an empty cart → carrinho_item_adicionado {valor_centavos, quantidade:1, origem}', () => {
    const c = coletor();
    const depois = cartReducer(vazio, { type: 'add', gift: gift('Body', 3) });
    const nome = emitirDeltaCarrinho(
      deltaLinhaCarrinho(vazio.lines, depois.lines, 'Body'),
      'card',
      c.emitir,
    );
    expect(nome).toBe('carrinho_item_adicionado');
    expect(c.emitidos).toEqual([
      {
        nome: 'carrinho_item_adicionado',
        props: { valor_centavos: 5000, quantidade: 1, origem: 'card' },
      },
    ]);
  });

  it('add at the qtyAvailable cap is a reducer NO-OP → no event', () => {
    const c = coletor();
    const one = cartReducer(vazio, { type: 'add', gift: gift('Body', 1) });
    const capped = cartReducer(one, { type: 'add', gift: gift('Body', 1) });
    expect(capped).toBe(one); // reducer returned the same state
    expect(
      emitirDeltaCarrinho(deltaLinhaCarrinho(one.lines, capped.lines, 'Body'), 'card', c.emitir),
    ).toBeNull();
    expect(c.emitidos).toHaveLength(0);
  });

  it('add of an esgotado gift (qtyAvailable 0) → no line, no event', () => {
    const c = coletor();
    const depois = cartReducer(vazio, { type: 'add', gift: gift('Sold', 0) });
    expect(depois.lines).toHaveLength(0);
    expect(
      emitirDeltaCarrinho(deltaLinhaCarrinho(vazio.lines, depois.lines, 'Sold'), 'card', c.emitir),
    ).toBeNull();
    expect(c.emitidos).toHaveLength(0);
  });

  it('increment → adicionado with the NEW line quantity; increment at cap → nothing', () => {
    const c = coletor();
    const one = cartReducer(vazio, { type: 'add', gift: gift('Body', 2) });
    const two = cartReducer(one, { type: 'increment', nome: 'Body' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(one.lines, two.lines, 'Body'), 'drawer', c.emitir);
    const still = cartReducer(two, { type: 'increment', nome: 'Body' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(two.lines, still.lines, 'Body'), 'drawer', c.emitir);
    expect(c.emitidos).toEqual([
      {
        nome: 'carrinho_item_adicionado',
        props: { valor_centavos: 5000, quantidade: 2, origem: 'drawer' },
      },
    ]);
  });

  it('decrement → removido with the new quantity; decrement to 0 drops the line (quantidade 0)', () => {
    const c = coletor();
    const two = cartReducer(cartReducer(vazio, { type: 'add', gift: gift('Body', 5) }), {
      type: 'increment',
      nome: 'Body',
    });
    const one = cartReducer(two, { type: 'decrement', nome: 'Body' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(two.lines, one.lines, 'Body'), 'card', c.emitir);
    const none = cartReducer(one, { type: 'decrement', nome: 'Body' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(one.lines, none.lines, 'Body'), 'card', c.emitir);
    expect(none.lines).toHaveLength(0);
    expect(c.emitidos.map((e) => [e.nome, e.props.quantidade])).toEqual([
      ['carrinho_item_removido', 1],
      ['carrinho_item_removido', 0],
    ]);
  });

  it('remove line → removido {quantidade:0}; remove of an unknown nome → nothing; clear is never a removal', () => {
    const c = coletor();
    const one = cartReducer(vazio, { type: 'add', gift: gift('Body', 5, 1234) });
    const gone = cartReducer(one, { type: 'remove', nome: 'Body' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(one.lines, gone.lines, 'Body'), 'drawer', c.emitir);
    const same = cartReducer(one, { type: 'remove', nome: 'Nope' });
    emitirDeltaCarrinho(deltaLinhaCarrinho(one.lines, same.lines, 'Nope'), 'drawer', c.emitir);
    expect(c.emitidos).toEqual([
      {
        nome: 'carrinho_item_removido',
        props: { valor_centavos: 1234, quantidade: 0, origem: 'drawer' },
      },
    ]);
    // clear: the provider never routes it through the delta (post-purchase).
    const cleared = cartReducer(one, { type: 'clear' });
    expect(cleared.lines).toHaveLength(0);
  });

  it('never carries the item name or any free text', () => {
    const c = coletor();
    const depois = cartReducer(vazio, { type: 'add', gift: gift('Nome Sensível', 3) });
    emitirDeltaCarrinho(
      deltaLinhaCarrinho(vazio.lines, depois.lines, 'Nome Sensível'),
      'card',
      c.emitir,
    );
    expect(JSON.stringify(c.emitidos)).not.toContain('Nome Sensível');
    expect(Object.keys(c.emitidos[0]?.props ?? {}).sort()).toEqual([
      'origem',
      'quantidade',
      'valor_centavos',
    ]);
  });
});

describe('wrapper boundary — two synchronous clicks before React rerenders (Izzy pre-freeze)', () => {
  // Fake provider: a cell the wrapper advances synchronously, and a dispatch
  // queue that React would apply IN ORDER through the same pure reducer.
  function fakeProvider(inicial: S) {
    let celulaEstado = inicial;
    const celula: CelulaEstado<S> = {
      obter: () => celulaEstado,
      avancar: (p) => {
        celulaEstado = p;
      },
    };
    const fila: Parameters<typeof cartReducer>[1][] = [];
    const dispatch = (a: Parameters<typeof cartReducer>[1]) => {
      fila.push(a);
    };
    // "rerender": React reduces the queue sequentially from the committed state.
    const commit = () => fila.reduce((s, a) => cartReducer(s, a), inicial);
    return { celula, dispatch, commit };
  }

  it('rapid double increment near cap → exactly ONE event (qty 2); the second click is a real no-op at cap', () => {
    const c = coletor();
    const one = cartReducer(vazio, { type: 'add', gift: gift('Body', 2) });
    const p = fakeProvider(one);
    // two clicks in the same tick — no rerender between them
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'increment', nome: 'Body' },
      'Body',
      'card',
      c.emitir,
    );
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'increment', nome: 'Body' },
      'Body',
      'card',
      c.emitir,
    );
    const committed = p.commit();
    expect(committed.lines[0]?.quantidade).toBe(2);
    expect(c.emitidos.map((e) => [e.nome, e.props.quantidade])).toEqual([
      ['carrinho_item_adicionado', 2],
    ]);
  });

  it('rapid double add from empty → two events with after-values 1 then 2, matching the committed sequence', () => {
    const c = coletor();
    const p = fakeProvider(vazio);
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'add', gift: gift('Body', 5) },
      'Body',
      'card',
      c.emitir,
    );
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'add', gift: gift('Body', 5) },
      'Body',
      'card',
      c.emitir,
    );
    const committed = p.commit();
    expect(committed.lines[0]?.quantidade).toBe(2);
    expect(c.emitidos.map((e) => e.props.quantidade)).toEqual([1, 2]);
  });

  it('rapid decrement twice from qty 1 → one removido {0}; the second is a no-op on a gone line', () => {
    const c = coletor();
    const one = cartReducer(vazio, { type: 'add', gift: gift('Body', 5) });
    const p = fakeProvider(one);
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'decrement', nome: 'Body' },
      'Body',
      'drawer',
      c.emitir,
    );
    despacharComDelta(
      p.celula,
      cartReducer,
      p.dispatch,
      { type: 'decrement', nome: 'Body' },
      'Body',
      'drawer',
      c.emitir,
    );
    expect(p.commit().lines).toHaveLength(0);
    expect(c.emitidos.map((e) => [e.nome, e.props.quantidade])).toEqual([
      ['carrinho_item_removido', 0],
    ]);
  });

  it('emitted after-values always equal the committed transitions for a mixed burst', () => {
    const c = coletor();
    const p = fakeProvider(vazio);
    const acoes: Parameters<typeof cartReducer>[1][] = [
      { type: 'add', gift: gift('A', 2) },
      { type: 'add', gift: gift('A', 2) },
      { type: 'add', gift: gift('A', 2) }, // cap → no-op
      { type: 'decrement', nome: 'A' },
      { type: 'remove', nome: 'A' },
      { type: 'remove', nome: 'A' }, // gone → no-op
    ];
    for (const a of acoes)
      despacharComDelta(p.celula, cartReducer, p.dispatch, a, 'A', 'card', c.emitir);
    expect(p.commit().lines).toHaveLength(0);
    expect(c.emitidos.map((e) => e.props.quantidade)).toEqual([1, 2, 1, 0]);
  });
});

describe('carrinho_aberto — only a real closed→open transition', () => {
  it('closed → emits {origem}; already open → nothing', () => {
    const c = coletor();
    expect(emitirCarrinhoAberto(false, 'adicionar', c.emitir)).toBe(true);
    expect(emitirCarrinhoAberto(true, 'botao', c.emitir)).toBe(false);
    expect(c.emitidos).toEqual([{ nome: 'carrinho_aberto', props: { origem: 'adicionar' } }]);
  });
});

describe('checkout_falhou — mutation REJECTED, finite code, never the message', () => {
  it('maps a tRPC client error to its finite code and carries metodo/valor/quantidade', () => {
    const c = coletor();
    emitirCheckoutFalhou(
      {
        metodo: 'credit_card',
        valorCentavos: 9900,
        quantidadeItens: 2,
        erro: { message: 'Contribuição já foi presenteada por Maria', data: { code: 'CONFLICT' } },
      },
      c.emitir,
    );
    expect(c.emitidos).toEqual([
      {
        nome: 'checkout_falhou',
        props: {
          etapa: 'iniciar',
          metodo: 'credit_card',
          valor_centavos: 9900,
          codigo: 'CONFLICT',
          quantidade_itens: 2,
        },
      },
    ]);
    expect(JSON.stringify(c.emitidos)).not.toContain('Maria');
  });

  it('network failure / non-tRPC throw / malformed code → codigo "desconhecido"', () => {
    expect(codigoErroTrpc(new TypeError('Failed to fetch'))).toBe('desconhecido');
    expect(codigoErroTrpc(null)).toBe('desconhecido');
    expect(codigoErroTrpc('boom')).toBe('desconhecido');
    expect(codigoErroTrpc({ data: { code: 'not a code; user@x.com' } })).toBe('desconhecido');
    expect(codigoErroTrpc({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(
      'INTERNAL_SERVER_ERROR',
    );
    expect(codigoErroTrpc({ data: { code: 'BAD_REQUEST' } })).toBe('BAD_REQUEST');
  });

  it('single-gift surface omits quantidade_itens', () => {
    const c = coletor();
    emitirCheckoutFalhou({ metodo: 'pix', valorCentavos: 100, erro: undefined }, c.emitir);
    expect('quantidade_itens' in (c.emitidos[0]?.props ?? {})).toBe(false);
    expect(c.emitidos[0]?.props.codigo).toBe('desconhecido');
  });
});

describe('pagamento_falhou (pix) — SERVER-reported terminal status only', () => {
  it('expirado / rejeitado map to a motivo; pendente, confirmado, undefined (countdown-only) → null', () => {
    expect(motivoPixFalhou('expirado')).toBe('expirado');
    expect(motivoPixFalhou('rejeitado')).toBe('rejeitado');
    expect(motivoPixFalhou('pendente')).toBeNull();
    expect(motivoPixFalhou('confirmado')).toBeNull();
    expect(motivoPixFalhou(undefined)).toBeNull();
  });

  it('emits {metodo:pix, motivo, transaction_id, valor_centavos}', () => {
    const c = coletor();
    emitirPixFalhou(
      { transactionId: 'txid-9', valorCentavos: 4200, motivo: 'rejeitado' },
      c.emitir,
    );
    expect(c.emitidos).toEqual([
      {
        nome: 'pagamento_falhou',
        props: {
          metodo: 'pix',
          motivo: 'rejeitado',
          transaction_id: 'txid-9',
          valor_centavos: 4200,
        },
      },
    ]);
  });
});

describe('source pins — call sites', () => {
  const PAGES = join(__dirname, '../../../apps/eunenem-server/pages');
  const src = (rel: string) => readFileSync(join(PAGES, rel), 'utf8');

  it('cart provider routes add/increment/decrement/remove through the synchronous-cell wrapper; clear does not', () => {
    const s = src('lib/cart.tsx');
    expect((s.match(/despacharComDelta\(celula, cartReducer, dispatch/g) ?? []).length).toBe(4);
    expect(/stateRef\.current = state;/.test(s)).toBe(true);
    expect(/clear: \(\) => dispatch\(\{ type: 'clear' \}\)/.test(s)).toBe(true);
  });

  it('carrinho_aberto sites guard on drawer.isOpen (Marketplace add-open, Navbar button)', () => {
    expect(
      /emitirCarrinhoAberto\(drawer\.isOpen, "adicionar"\)/.test(
        src('components/eunenem/Marketplace.tsx'),
      ),
    ).toBe(true);
    expect(
      /emitirCarrinhoAberto\(drawer\.isOpen, "botao"\)/.test(src('components/eunenem/Navbar.tsx')),
    ).toBe(true);
    expect(
      (
        src('components/eunenem/Navbar.tsx').match(/<CartButton onOpen=\{abrirCarrinho\} \/>/g) ??
        []
      ).length,
    ).toBe(2);
  });

  it('checkout_falhou is emitted from every iniciar catch (2 per surface) and no catch is left silent', () => {
    for (const rel of [
      'components/eunenem/CartDrawer.tsx',
      'components/eunenem/GiftCheckoutModal.tsx',
    ]) {
      const s = src(rel);
      expect({ rel, n: (s.match(/emitirCheckoutFalhou\(/g) ?? []).length }).toEqual({ rel, n: 2 });
      expect({ rel, silent: /\} catch \{/.test(s) }).toEqual({ rel, silent: false });
    }
  });

  it('PixQrPanel emits pix failure from the polled server status, once per txid, never from the countdown', () => {
    const s = src('components/eunenem/PixCheckout.tsx');
    expect(/motivoPixFalhou\(polledStatus\)/.test(s)).toBe(true);
    expect(/falhaFiredRef\.current = true;/.test(s)).toBe(true);
    expect(/motivoPixFalhou\([^)]*countdownExpired/.test(s)).toBe(false);
  });
});
