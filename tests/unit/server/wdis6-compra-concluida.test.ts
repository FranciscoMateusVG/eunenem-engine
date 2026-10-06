/**
 * aperture-wdis6 — compra_concluida as a CLIENT confirmation event with
 * best-effort per-browser dedupe, and pix_qr_regenerado vs checkout_iniciado
 * on PIX QR regenerate (Wheatley T1.5 contract).
 *
 * Honest scope (node env, no DOM): proves the prop contract both sinks agreed
 * on; that the dedupe runs BEFORE the emitter and survives a "reload" (fresh
 * registry over the same storage); that a blank transaction_id is NOT
 * emitted; and the DOCUMENTED LIMITS — a new browser profile (different
 * storage) emits the same payment again, blocked storage degrades to
 * page-lifetime dedupe, and two tabs interleaving on the same storage can
 * both emit (no atomic check-and-set). Source pins keep every surface on the
 * funnel. What it does NOT prove: real localStorage, GA4/Mixpanel ingestion,
 * or that either destination dedupes anything — local dedupe before the
 * emitter is not delivery evidence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ArmazenamentoConversao,
  criarRegistroConversao,
  EVENTO_CHECKOUT_INICIADO,
  EVENTO_COMPRA_CONCLUIDA,
  EVENTO_PIX_QR_REGENERADO,
  emitirInicioCheckoutPix,
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

const compra = (
  transactionId: string,
  extra: Partial<Parameters<typeof registrarCompraConcluida>[0]> = {},
) => ({
  transactionId,
  valorCentavos: 1000,
  metodo: 'credit_card' as const,
  giftName: 'A',
  ...extra,
});

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

describe('registrarCompraConcluida — dedupe BEFORE the emitter (what IS guaranteed, per browser)', () => {
  it('emits once per transaction_id; the second call for the same payment is suppressed', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    expect(registrarCompraConcluida(compra('cs_1'), { registro, emitir: c.emitir })).toBe(
      'emitida',
    );
    expect(registrarCompraConcluida(compra('cs_1'), { registro, emitir: c.emitir })).toBe(
      'ja_emitida',
    );
    expect(c.emitidos).toHaveLength(1);
    expect(c.emitidos[0]?.nome).toBe(EVENTO_COMPRA_CONCLUIDA);
    expect(c.emitidos[0]?.props.transaction_id).toBe('cs_1');
  });

  it('survives a reload: a FRESH registry over the same storage still suppresses (the /sucesso F5 case)', () => {
    const storage = armazenamentoEmMemoria();
    const c = coletor();
    expect(
      registrarCompraConcluida(compra('cs_reload'), {
        registro: criarRegistroConversao(storage),
        emitir: c.emitir,
      }),
    ).toBe('emitida');
    // new page lifetime → new in-memory registry, same localStorage
    expect(
      registrarCompraConcluida(compra('cs_reload'), {
        registro: criarRegistroConversao(storage),
        emitir: c.emitir,
      }),
    ).toBe('ja_emitida');
    expect(c.emitidos).toHaveLength(1);
  });

  it('different payments are independent', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    registrarCompraConcluida(compra('cs_a', { metodo: 'pix' }), { registro, emitir: c.emitir });
    registrarCompraConcluida(compra('cs_b', { metodo: 'pix' }), { registro, emitir: c.emitir });
    expect(c.emitidos.map((e) => e.props.transaction_id)).toEqual(['cs_a', 'cs_b']);
  });

  it('a blank transaction_id is NOT emitted (no identity → not countable), UI flow unaffected (no throw)', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    expect(registrarCompraConcluida(compra('  '), { registro, emitir: c.emitir })).toBe(
      'sem_identidade',
    );
    expect(registrarCompraConcluida(compra(''), { registro, emitir: c.emitir })).toBe(
      'sem_identidade',
    );
    expect(c.emitidos).toHaveLength(0);
  });

  it('trims the id so " cs_x " and "cs_x" are the same payment', () => {
    const c = coletor();
    const registro = criarRegistroConversao(armazenamentoEmMemoria());
    expect(registrarCompraConcluida(compra(' cs_x '), { registro, emitir: c.emitir })).toBe(
      'emitida',
    );
    expect(registrarCompraConcluida(compra('cs_x'), { registro, emitir: c.emitir })).toBe(
      'ja_emitida',
    );
    expect(c.emitidos[0]?.props.transaction_id).toBe('cs_x');
  });
});

describe('registrarCompraConcluida — documented LIMITS (what is NOT guaranteed)', () => {
  it('a different browser profile (different storage) emits the same payment AGAIN', () => {
    const c = coletor();
    const perfilA = criarRegistroConversao(armazenamentoEmMemoria());
    const perfilB = criarRegistroConversao(armazenamentoEmMemoria());
    expect(
      registrarCompraConcluida(compra('cs_shared'), { registro: perfilA, emitir: c.emitir }),
    ).toBe('emitida');
    expect(
      registrarCompraConcluida(compra('cs_shared'), { registro: perfilB, emitir: c.emitir }),
    ).toBe('emitida');
    expect(c.emitidos).toHaveLength(2); // browser-local dedupe is not payment state
  });

  it('blocked storage (Safari private / quota) degrades to page-lifetime dedupe only — never breaks the flow', () => {
    const quebrado: ArmazenamentoConversao = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const c = coletor();
    const mesmaPagina = criarRegistroConversao(quebrado);
    expect(
      registrarCompraConcluida(compra('cs_priv'), { registro: mesmaPagina, emitir: c.emitir }),
    ).toBe('emitida');
    expect(
      registrarCompraConcluida(compra('cs_priv'), { registro: mesmaPagina, emitir: c.emitir }),
    ).toBe('ja_emitida');
    // a reload (fresh registry) over the still-broken storage emits again
    expect(
      registrarCompraConcluida(compra('cs_priv'), {
        registro: criarRegistroConversao(quebrado),
        emitir: c.emitir,
      }),
    ).toBe('emitida');
    expect(c.emitidos).toHaveLength(2);
  });

  it('two tabs interleaving on the same storage can BOTH emit (no atomic check-and-set); sequential tabs do not', () => {
    const storage = armazenamentoEmMemoria();
    const c = coletor();
    const abaA = criarRegistroConversao(storage);
    const abaB = criarRegistroConversao(storage);
    // Race: both tabs pass the check before either marks.
    const aVe = abaA.jaEmitida('cs_race');
    const bVe = abaB.jaEmitida('cs_race');
    expect([aVe, bVe]).toEqual([false, false]);
    abaA.marcarEmitida('cs_race');
    abaB.marcarEmitida('cs_race');
    // The public API on a later, sequential tab sees the mark.
    expect(
      registrarCompraConcluida(compra('cs_race'), {
        registro: criarRegistroConversao(storage),
        emitir: c.emitir,
      }),
    ).toBe('ja_emitida');
    expect(c.emitidos).toHaveLength(0);
  });
});

describe('emitirInicioCheckoutPix — checkout_iniciado once per intent; QR regenerate is pix_qr_regenerado', () => {
  it('first iniciar → checkout_iniciado with the pre-existing props (no transaction_id)', () => {
    const c = coletor();
    expect(
      emitirInicioCheckoutPix(
        { regenerando: false, transactionId: 'tx1', valorCentavos: 5000, quantidadeItens: 2 },
        c.emitir,
      ),
    ).toBe(EVENTO_CHECKOUT_INICIADO);
    expect(c.emitidos).toEqual([
      {
        nome: 'checkout_iniciado',
        props: { valor_centavos: 5000, quantidade_itens: 2, metodo: 'pix' },
      },
    ]);
  });

  it('single-gift surface omits quantidade_itens on checkout_iniciado (unchanged shape)', () => {
    const c = coletor();
    emitirInicioCheckoutPix(
      { regenerando: false, transactionId: 'tx1', valorCentavos: 5000 },
      c.emitir,
    );
    expect(c.emitidos[0]?.props).toEqual({ valor_centavos: 5000, metodo: 'pix' });
  });

  it('regenerate after expiry/rejection → pix_qr_regenerado {transaction_id, valor_centavos, metodo} and NOT checkout_iniciado', () => {
    const c = coletor();
    expect(
      emitirInicioCheckoutPix(
        { regenerando: true, transactionId: 'tx2', valorCentavos: 5000, quantidadeItens: 2 },
        c.emitir,
      ),
    ).toBe(EVENTO_PIX_QR_REGENERADO);
    expect(c.emitidos).toEqual([
      {
        nome: 'pix_qr_regenerado',
        props: { transaction_id: 'tx2', valor_centavos: 5000, metodo: 'pix' },
      },
    ]);
    expect(c.emitidos.some((e) => e.nome === 'checkout_iniciado')).toBe(false);
  });

  it('armed retry but NO new txid (server answered stripe_embedded) → plain checkout_iniciado, never a blank-id pix_qr_regenerado', () => {
    const c = coletor();
    // Exactly the call-site shape: regenerando from the ref, transactionId '' when result.tipo !== 'pix_qr'.
    expect(
      emitirInicioCheckoutPix(
        { regenerando: true, transactionId: '', valorCentavos: 5000, quantidadeItens: 2 },
        c.emitir,
      ),
    ).toBe(EVENTO_CHECKOUT_INICIADO);
    expect(
      emitirInicioCheckoutPix(
        { regenerando: true, transactionId: '   ', valorCentavos: 5000 },
        c.emitir,
      ),
    ).toBe(EVENTO_CHECKOUT_INICIADO);
    expect(c.emitidos.map((e) => e.nome)).toEqual(['checkout_iniciado', 'checkout_iniciado']);
    expect(c.emitidos.some((e) => e.nome === 'pix_qr_regenerado')).toBe(false);
    expect(c.emitidos.some((e) => 'transaction_id' in e.props)).toBe(false);
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
  const src = (rel: string) => readFileSync(join(PAGES, rel), 'utf8');

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
      const n = (src(rel).match(/registrarCompraConcluida\(/g) ?? []).length;
      expect({ rel, n }).toEqual({ rel, n: esperado });
    }
  });

  it('PIX identity submit uses emitirInicioCheckoutPix and onPixRetry arms the regenerate flag (both surfaces)', () => {
    for (const rel of [
      'components/eunenem/CartDrawer.tsx',
      'components/eunenem/GiftCheckoutModal.tsx',
    ]) {
      const s = src(rel);
      // exactly one PIX-path emitter, and no raw metodo:"pix" checkout_iniciado left behind
      expect({ rel, n: (s.match(/emitirInicioCheckoutPix\(/g) ?? []).length }).toEqual({
        rel,
        n: 1,
      });
      expect({
        rel,
        raw: /sendEvent\(\s*"checkout_iniciado",[^)]*metodo:\s*"pix"/s.test(s),
      }).toEqual({ rel, raw: false });
      // the flag is armed inside onPixRetry and consumed after a successful iniciar
      expect({
        rel,
        armed: /onPixRetry = useCallback\(\(\) => \{\s*pixRegenerandoRef\.current = true;/.test(s),
      }).toEqual({ rel, armed: true });
      expect({ rel, consumed: /pixRegenerandoRef\.current = false;/.test(s) }).toEqual({
        rel,
        consumed: true,
      });
      // and the call site only classifies a regenerate when a NEW QR came back (Izzy sdg24h boundary)
      expect({
        rel,
        gated: /regenerando: pixRegenerandoRef\.current && result\.tipo === "pix_qr"/.test(s),
      }).toEqual({ rel, gated: true });
    }
  });
});
