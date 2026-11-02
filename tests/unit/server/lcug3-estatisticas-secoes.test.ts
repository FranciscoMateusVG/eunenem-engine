import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  EstatisticasLayout,
  EstatisticasPainel,
} from '../../../apps/eunenem-server/pages/AdminEstatisticasPage.js';
import { resolveRoute } from '../../../apps/eunenem-server/pages/App.js';
import { agregarEstatisticas } from '../../../apps/eunenem-server/pages/lib/estatisticas.js';
import {
  hrefSecao,
  mesesFromSearch,
  secaoFromPath,
} from '../../../apps/eunenem-server/pages/lib/estatisticasSecoes.js';

/** aperture-lcug3 — Estatísticas em sub-seções: rotas, período na URL e abas. */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');

describe('rotas das sub-seções', () => {
  it.each([
    ['/admin/estatisticas', 'funil'],
    ['/admin/estatisticas/', 'funil'],
    ['/admin/estatisticas/vendas', 'vendas'],
    ['/admin/estatisticas/listas', 'listas'],
    ['/admin/estatisticas/financeiro/', 'financeiro'],
    ['/admin/estatisticas/trafego/', 'trafego'],
    ['/admin/estatisticas/saude', 'saude'],
  ])('%s → %s', (path, secao) => {
    expect(resolveRoute(path)).toEqual({ kind: 'admin-estatisticas', secao });
  });

  it('caminhos desconhecidos não viram seção', () => {
    expect(secaoFromPath('/admin/estatisticas/outra')).toBeNull();
    expect(secaoFromPath('/admin')).toBeNull();
    expect(resolveRoute('/admin/estatisticas/outra').kind).not.toBe('admin-estatisticas');
  });
});

describe('período na URL', () => {
  it('aceita só 3/6/12; o resto cai em 3', () => {
    expect(mesesFromSearch('?meses=6')).toBe(6);
    expect(mesesFromSearch('meses=12')).toBe(12);
    expect(mesesFromSearch('?meses=5')).toBe(3);
    expect(mesesFromSearch('?meses=abc')).toBe(3);
    expect(mesesFromSearch('')).toBe(3);
  });

  it('3 não aparece na URL; os demais seguem no href', () => {
    expect(hrefSecao('funil', 3)).toBe('/admin/estatisticas');
    expect(hrefSecao('vendas', 6)).toBe('/admin/estatisticas/vendas?meses=6');
    expect(hrefSecao('saude', 12)).toBe('/admin/estatisticas/saude?meses=12');
  });
});

describe('layout', () => {
  const data = agregarEstatisticas(
    [{ dia: '2026-10-19', novos: 8, excluidos: 0 }],
    new Date('2026-10-30T16:18:10Z'),
  );
  const render = (secao: 'funil' | 'vendas', meses: 3 | 6 | 12) =>
    renderToStaticMarkup(
      React.createElement(
        EstatisticasLayout,
        { secao, meses, onMeses: () => {} },
        React.createElement(EstatisticasPainel, { data, meses }),
      ),
    );

  it('abas como links, aba ativa marcada e período propagado', () => {
    const html = render('vendas', 6);
    for (const label of ['Funil', 'Vendas', 'Listas', 'Financeiro', 'Tráfego', 'Saúde &amp; erros'])
      expect(html).toContain(label);
    expect(html).toMatch(/href="\/admin\/estatisticas\/vendas\?meses=6" aria-current="page"/);
    expect(html).toContain('href="/admin/estatisticas?meses=6"');
    expect(html).toContain('value="6" selected');
  });

  it('o seletor controla quantos meses o gráfico mostra', () => {
    for (const n of [3, 6, 12] as const)
      expect(render('funil', n).match(/data-testid="estatisticas-mes"/g)).toHaveLength(n);
  });
});
