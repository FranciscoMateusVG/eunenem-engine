import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ListasSecao,
  somarHorizontes,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/ListasSecao.js';
import type { ListasData } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/types.js';

/** aperture-lcug3 — o que a seção Listas DIZ, inclusive as notas de cobertura. */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');

const cob = (nota: string, parcial = true, denominador = 10, observados = 6) => ({
  nota,
  parcial,
  denominador,
  observados,
});
const meses = [
  { de: '2026-09-01', ate: '2026-10-01', parcial: false },
  { de: '2026-10-01', ate: '2026-11-01', parcial: false },
  { de: '2026-11-01', ate: '2026-12-01', parcial: true },
];
const h = (dias: 7 | 30 | 60, eleg: number, imat: number, gmv: number) => ({
  dias,
  listasElegiveis: eleg,
  listasImaturas: imat,
  gmvCents: gmv,
  margemCents: gmv / 10,
  pagamentos: eleg,
  pagamentosComCusto: eleg,
});
const coorte = (de: string, origem: string, legado: string, eleg: number) => ({
  de,
  ate: meses.find((m) => m.de === de)?.ate ?? '',
  parcial: false,
  origem,
  legado,
  horizontes: [h(7, eleg, 0, eleg * 10_000), h(30, eleg, 1, eleg * 20_000), h(60, 0, eleg, 0)],
});

const data = {
  hoje: '2026-11-01',
  snapshotAt: '2026-11-01T15:00:00.000Z',
  periodo: { de: '2026-09-01', ate: '2026-11-02' },
  meses,
  semanas: [],
  listas: 12,
  primeiroPresente: {
    medianaDias: 4.5,
    p90Dias: 21,
    listasComPresente: 7,
    listasSemPresente: 5,
    janelas: [
      { dias: 7, elegiveis: 10, semPresente: 4, percentualSemPresente: 40 },
      { dias: 14, elegiveis: 8, semPresente: 2, percentualSemPresente: 25 },
      { dias: 30, elegiveis: 0, semPresente: 0, percentualSemPresente: null },
    ],
    cobertura: cob('NOTA-PRIMEIRO'),
  },
  coortes: [
    coorte('2026-09-01', 'google_ads', 'nao', 2),
    coorte('2026-09-01', 'direto', 'sim', 3),
    coorte('2026-10-01', 'direto', 'nao', 1),
  ],
  coberturaCoortes: cob('NOTA-COORTES'),
  pagadores: {
    pagamentosAprovados: 30,
    pagamentosComEmail: 28,
    pagadoresUnicos: 20,
    pagadoresRecorrentes: 5,
    percentualRecorrentes: 25,
    medianaPorLista: 2,
    p90PorLista: 6,
    cobertura: cob('NOTA-PAGADORES'),
  },
  risco: {
    semData: 3,
    faixas: [
      { deDias: 0, ateDias: 3, listas: 2, semPrimeiroPresente: 1, semPagamento7Dias: 2 },
      { deDias: 4, ateDias: 7, listas: 1, semPrimeiroPresente: 0, semPagamento7Dias: 0 },
      { deDias: 8, ateDias: 14, listas: 0, semPrimeiroPresente: 0, semPagamento7Dias: 0 },
    ],
    cobertura: cob('NOTA-RISCO'),
  },
  curvaEvento: {
    dias: Array.from({ length: 38 }, (_, i) => ({
      diaRelativo: i - 30,
      pagamentos: i % 5,
      gmvCents: 1000,
    })),
    cobertura: cob('NOTA-CURVA', false, 10, 10),
  },
  concentracao: {
    listas: 12,
    listasSemReceita: 5,
    gmvCents: 500_000,
    margemCents: 20_000,
    top10GmvPct: 92.5,
    top10MargemPct: null,
    cobertura: cob('NOTA-CONCENTRACAO'),
  },
} as unknown as ListasData;

describe('Listas', () => {
  const html = renderToStaticMarkup(React.createElement(ListasSecao, { data })) as string;

  it('todas as notas de cobertura aparecem, parciais destacadas', () => {
    for (const n of ['PRIMEIRO', 'COORTES', 'PAGADORES', 'RISCO', 'CURVA', 'CONCENTRACAO'])
      expect(html).toContain(`NOTA-${n}`);
    expect(html.match(/data-parcial="true"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('Dado parcial.');
    expect(html).toContain('6 de 10 listas com o dado');
  });

  it('janela sem listas maduras mostra —, não 0%', () => {
    expect(html.match(/data-testid="listas-janela"/g)).toHaveLength(3);
    expect(html).toContain('40%');
    expect(html).toMatch(/Primeiros 30 dias<\/th><td[^>]*>0<\/td><td[^>]*>0<\/td><td[^>]*>—</);
  });

  it('coortes por mês, origem e legado; D60 sem listas maduras é —', () => {
    // 3 meses + 2 origens + 2 legados.
    expect(html.match(/data-testid="listas-coorte"/g)).toHaveLength(7);
    expect(html).toContain('ainda sem D60');
    expect(html).toContain('Google Ads');
    expect(html).toContain('Veio do legado');
  });

  it('risco, curva D-30..D+7 e concentração', () => {
    expect(html.match(/data-testid="listas-risco"/g)).toHaveLength(3);
    expect(html).toContain('3 listas sem data de evento');
    expect(html.match(/data-testid="listas-curva"/g)).toHaveLength(38);
    expect(html).toContain('D-30');
    expect(html).toContain('D+7');
    expect(html).toContain('92,5%');
  });
});

it('somarHorizontes soma linhas disjuntas por horizonte', () => {
  const [d7, d30, d60] = somarHorizontes(data.coortes.slice(0, 2));
  expect(d7).toMatchObject({ dias: 7, listasElegiveis: 5, gmvCents: 50_000 });
  expect(d30).toMatchObject({ dias: 30, listasElegiveis: 5, listasImaturas: 2 });
  expect(d60).toMatchObject({ dias: 60, listasElegiveis: 0, listasImaturas: 5 });
});
