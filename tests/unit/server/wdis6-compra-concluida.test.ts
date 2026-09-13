/**
 * aperture-wdis6 — ONE monetary conversion per payment (GA4 + Mixpanel).
 *
 * Honest scope (node env, no DOM): proves the prop contract both sinks agreed
 * on, the dedupe-before-emit rule keyed on a durable payment id that survives
 * a "reload" (fresh registry over the same storage), the storage-failure
 * fallback, and — at source level — that no page/component fires
 * `compra_concluida` raw any more (every site goes through the funnel).
 * What it does NOT prove: actual GA4/Mixpanel ingestion, or the browser's
 * real localStorage; that is runtime/reporting evidence recorded on the bead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ArmazenamentoConversao,
  criarRegistroConversao,
  EVENTO_COMPRA_CONCLUIDA,
  montarPropsCompraConcluida,
  registrarCompraConcluida,
} from '../../../apps/eunenem-server/pages/lib/analytics-conversao.js';

function armazenamentoEmMemoria(): ArmazenamentoConversao & { mapa: Map<string, string> } {
  const mapa = new Map<string, string>();
  return {
    mapa,
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => {
      mapa.set(k, v);
    },
  };
}

function coletor() {
  const emitidos: Array<{ nome: string; props: Record<string, unknown> }> = [];
  return {
    emitidos,
    emitir: (nome: string, props: Record<string, unknown>) => {
      emitidos.push({ nome, props });
    },
  };
}

describe('montarPropsCompraConcluida — prop contract shared by GA4 and Mixpanel', () => {
  it('carries transaction_id, decimal BRL value + currency, centavos parity, metodo, gift_name', () => {
    expect(
      montarPropsCompraConcluida({
        transactionId: 'cs_test_abc',
        valorCentavos: 12990,
        metodo: 'credit_card',
        giftName: 'Carrinho',
        quantidadeItens: 3,
      }),
    ).toEqual({
      transaction_id: 'cs_test_abc',
      value: 129.9,
      currency: 'BRL',
      valor_centavos: 12990,
      valor: 12990,
      metodo: 'credit_card',
      gift_name: 'Carrinho',
      quantidade_itens: 3,
    });
  });

  it('omits quantidade_itens when the surface does not know it, and never emits $-prefixed keys', () => {
    const props = montarPropsCompraConcluida({
      transactionId: 'txid1',
      valorCentavos: 5000,
      metodo: 'pix',
      giftName: 'Body',
    });
    expect('quantidade_itens' in props).toBe(false);
    expect(Object.keys(props).some((k) => k.startsWith('$'))).toBe(false);
  });
});

describe('registrarCompraConcluida — dedupe BEFORE the emitter, so both sinks see one event', () => {
  it('emits once per transaction_id; the second call for the same payment is dropped', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    const input = {
      transactionId: 'cs_1',
      valorCentavos: 1000,
      metodo: 'credit_card' as const,
      giftName: 'A',
    };
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(true);
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(false);
    expect(c.emitidos).toHaveLength(1);
    expect(c.emitidos[0]?.nome).toBe(EVENTO_COMPRA_CONCLUIDA);
    expect(c.emitidos[0]?.props.transaction_id).toBe('cs_1');
  });

  it('survives a reload: a FRESH registry over the same storage still dedupes (the /sucesso F5 case)', () => {
    const storage = armazenamentoEmMemoria();
    const c = coletor();
    const input = {
      transactionId: 'cs_reload',
      valorCentavos: 1000,
      metodo: 'credit_card' as const,
      giftName: 'A',
    };
    expect(
      registrarCompraConcluida(input, {
        registro: criarRegistroConversao(storage),
        emitir: c.emitir,
      }),
    ).toBe(true);
    // new page lifetime → new in-memory registry, same localStorage
    expect(
      registrarCompraConcluida(input, {
        registro: criarRegistroConversao(storage),
        emitir: c.emitir,
      }),
    ).toBe(false);
    expect(c.emitidos).toHaveLength(1);
  });

  it('different payments are independent (inline surface + a later /sucesso for another session both count)', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    registrarCompraConcluida(
      { transactionId: 'cs_a', valorCentavos: 1, metodo: 'pix', giftName: 'A' },
      { registro, emitir: c.emitir },
    );
    registrarCompraConcluida(
      { transactionId: 'cs_b', valorCentavos: 2, metodo: 'pix', giftName: 'B' },
      { registro, emitir: c.emitir },
    );
    expect(c.emitidos.map((e) => e.props.transaction_id)).toEqual(['cs_a', 'cs_b']);
  });

  it('falls back to in-memory dedupe when storage throws (Safari private mode), never breaking the flow', () => {
    const quebrado: ArmazenamentoConversao = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const c = coletor();
    const registro = criarRegistroConversao(quebrado);
    const input = {
      transactionId: 'cs_priv',
      valorCentavos: 1,
      metodo: 'pix' as const,
      giftName: 'A',
    };
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(true);
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(false);
    expect(c.emitidos).toHaveLength(1);
  });

  it('never silently drops a conversion with an empty transaction id (emits, undeduped, id gap visible in reports)', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    const input = { transactionId: '  ', valorCentavos: 1, metodo: 'pix' as const, giftName: 'A' };
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(true);
    expect(registrarCompraConcluida(input, { registro, emitir: c.emitir })).toBe(true);
    expect(c.emitidos).toHaveLength(2);
  });
});

describe('source pin — every surface goes through the funnel', () => {
  const PAGES = join(__dirname, '../../../apps/eunenem-server/pages');
  function arquivosTsx(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? arquivosTsx(p) : /\.tsx?$/.test(n) ? [p] : [];
    });
  }

  it('no page/component calls sendEvent("compra_concluida") raw any more', () => {
    const ofensores = arquivosTsx(PAGES)
      .filter((p) => !p.endsWith('analytics-conversao.ts'))
      .filter((p) => /sendEvent\(\s*["']compra_concluida["']/.test(readFileSync(p, 'utf8')));
    expect(ofensores).toEqual([]);
  });

  it('the five known surfaces call registrarCompraConcluida', () => {
    const sites: Array<[string, number]> = [
      ['PaginaSucessoPage.tsx', 1],
      ['components/eunenem/CartDrawer.tsx', 2],
      ['components/eunenem/GiftCheckoutModal.tsx', 2],
    ];
    for (const [rel, esperado] of sites) {
      const src = readFileSync(join(PAGES, rel), 'utf8');
      const n = (src.match(/registrarCompraConcluida\(/g) ?? []).length;
      expect({ rel, n }).toEqual({ rel, n: esperado });
    }
  });
});
