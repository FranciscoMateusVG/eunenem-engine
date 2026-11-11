import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../../apps/eunenem-server/pages/App.js';
import { CaixaPainel } from '../../../apps/eunenem-server/pages/components/eunenem/admin/caixa/CaixaPainel.js';
import { PagamentosTabs } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentosTabs.js';
import { centavosParaReais } from '../../../apps/eunenem-server/pages/lib/caixaCsv.js';
import { bucketsDoPeriodoCaixa } from '../../../apps/eunenem-server/pages/lib/caixaPeriodo.js';

/** aperture-zoxel — Fluxo de caixa: rota, aba, buckets e texto da tela (sem browser, sem banco). */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const ZERO = {
  presenteCents: 0,
  taxaCents: 0,
  adicionalCartaoCents: 0,
  brutoCents: 0,
  estornosCents: 0,
  liquidoCents: 0,
};

function painel(sobre: Record<string, unknown> = {}) {
  return {
    snapshotAt: '2033-06-18T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    hoje: '2033-06-18',
    periodo: { de: '2033-08-01', ate: '2033-09-01', granularidade: 'mes' },
    entradas: {
      presenteCents: 15_000,
      taxaCents: 1_050,
      adicionalCartaoCents: 183,
      brutoCents: 16_233,
      estornosCents: 0,
      liquidoCents: 16_233,
      pagamentos: 2,
      porMetodo: {
        pix: {
          ...ZERO,
          presenteCents: 10_000,
          taxaCents: 700,
          brutoCents: 10_700,
          liquidoCents: 10_700,
        },
        credit_card: {
          ...ZERO,
          presenteCents: 5_000,
          taxaCents: 350,
          adicionalCartaoCents: 183,
          brutoCents: 5_533,
          liquidoCents: 5_533,
        },
        nao_registrado: ZERO,
      },
    },
    saidas: {
      totalCents: 5_000,
      repasses: 1,
      porMetodo: { inter: { cents: 5_000, repasses: 1 }, manual: { cents: 0, repasses: 0 } },
    },
    pendentes: {
      aprovadosNaoTransferidos: { cents: 3_000, repasses: 1 },
      emVerificacao: { cents: 7_000, repasses: 1 },
      semComprovante: { cents: 1_500, repasses: 1 },
    },
    saldoCents: 11_233,
    serie: [
      {
        inicio: '2033-08-01',
        fim: '2033-09-01',
        parcial: false,
        entradasBrutasCents: 16_233,
        estornosCents: 0,
        entradasLiquidasCents: 16_233,
        saidasCents: 5_000,
        saldoCents: 11_233,
      },
    ],
    conciliacao: {
      totalIndependente: { entradasBrutasCents: 16_233, estornosCents: 0, saidasCents: 5_000 },
      somaSerie: { entradasBrutasCents: 16_233, estornosCents: 0, saidasCents: 5_000 },
      totalPagoDosPagamentosCents: 16_233,
      totalDosRepassesCents: 5_000,
      diferencas: {
        entradasBrutasCents: 0,
        estornosCents: 0,
        saidasCents: 0,
        totalPagoCents: 0,
        repassesCents: 0,
      },
    },
    ...sobre,
  };
}

const render = (data: unknown) =>
  renderToStaticMarkup(
    React.createElement(CaixaPainel, {
      data: data as never,
      aoBaixarCsv: async () => {},
    }),
  )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ');

describe('Fluxo de caixa — rota e aba', () => {
  it('aba Fluxo de caixa é link com rota própria', () => {
    const html = renderToStaticMarkup(React.createElement(PagamentosTabs, { active: 'caixa' }));
    expect(html).toContain('href="/admin/pagamentos/caixa" aria-current="page"');
    expect(resolveRoute('/admin/pagamentos/caixa')).toEqual({ kind: 'admin-pagamentos-caixa' });
    expect(resolveRoute('/admin/pagamentos/caixa/')).toEqual({ kind: 'admin-pagamentos-caixa' });
  });
});

describe('Fluxo de caixa — buckets', () => {
  it('dia/semana/mês com parcial e limites inválidos', () => {
    const d = bucketsDoPeriodoCaixa({ de: '2033-08-30', ate: '2033-09-02', granularidade: 'dia' });
    expect(d.ok && d.buckets.map((b) => b.inicio)).toEqual([
      '2033-08-30',
      '2033-08-31',
      '2033-09-01',
    ]);
    const s = bucketsDoPeriodoCaixa({
      de: '2033-08-03',
      ate: '2033-08-20',
      granularidade: 'semana',
    });
    expect(s.ok && s.buckets.map((b) => [b.inicio, b.parcial])).toEqual([
      ['2033-08-01', true],
      ['2033-08-08', false],
      ['2033-08-15', true],
    ]);
    expect(
      bucketsDoPeriodoCaixa({ de: '2033-09-01', ate: '2033-08-01', granularidade: 'dia' }),
    ).toEqual({ ok: false, erro: 'intervalo_vazio' });
    expect(
      bucketsDoPeriodoCaixa({ de: '2033-02-30', ate: '2033-08-01', granularidade: 'dia' }),
    ).toEqual({ ok: false, erro: 'data_invalida' });
    expect(
      bucketsDoPeriodoCaixa({ de: '2020-01-01', ate: '2033-08-01', granularidade: 'dia' }),
    ).toEqual({ ok: false, erro: 'buckets_demais' });
  });

  it('centavos em reais sem ponto flutuante', () => {
    expect(centavosParaReais(12_345)).toBe('123,45');
    expect(centavosParaReais(-5)).toBe('-0,05');
    expect(centavosParaReais(0)).toBe('0,00');
  });
});

describe('Fluxo de caixa — texto da tela', () => {
  it('pendente fica separado e explicitamente fora da saída; conciliado', () => {
    const t = render(painel());
    expect(t).toContain('Entrou');
    expect(t).toContain('Aprovados, ainda não transferidos');
    expect(t).toContain('Em verificação');
    expect(t).toContain('Marcado como transferido sem comprovante — conferir');
    expect(t).toContain('Não conta como saída');
    expect(t).toContain('Fecha ao centavo');
    expect(t).toContain('Período: 01/08/2033 a 31/08/2033');
  });

  it('diferença de conciliação nunca é escondida', () => {
    const base = painel();
    const t = render({
      ...base,
      conciliacao: {
        ...base.conciliacao,
        diferencas: { ...base.conciliacao.diferencas, repassesCents: 7 },
      },
    });
    expect(t).toContain('não fecham ao centavo');
    expect(t).not.toContain('Fecha ao centavo');
  });
});
