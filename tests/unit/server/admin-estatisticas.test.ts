import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { EstatisticasPainel } from '../../../apps/eunenem-server/pages/AdminEstatisticasPage.js';
import { agregarEstatisticas } from '../../../apps/eunenem-server/pages/lib/estatisticas.js';

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
it('grade preenchida, base zero indefinida e média móvel inclui zeros', () => {
  const p = agregarEstatisticas(
    [
      { dia: '2026-10-19', novos: 8, excluidos: 2 },
      { dia: '2026-10-26', novos: 4, excluidos: 0 },
    ],
    new Date('2026-10-30T16:18:10Z'),
  );
  expect(p.total).toBe(12);
  expect(p.excluidos).toBe(2);
  expect(p.semanas.at(-2)).toMatchObject({
    novos: 8,
    variacaoPct: null,
    media4Semanas: 2,
    parcial: false,
  });
  expect(p.semanas.at(-1)).toMatchObject({
    novos: 4,
    variacaoPct: -50,
    media4Semanas: 3,
    parcial: true,
  });
  const html = renderToStaticMarkup(React.createElement(EstatisticasPainel, { data: p }));
  expect(html).toContain('Estatísticas');
  expect(html).toContain('value="3" selected');
  expect(html.match(/data-testid="estatisticas-mes"/g)).toHaveLength(3);
  expect(html.match(/data-testid="estatisticas-semana"/g)).toHaveLength(12);
  expect(html).toContain('base zero');
  expect(html).toContain('parcial');
  expect(html).toContain('migração');
});

it('reproduz o relatório jbd25 no mesmo recorte, sem projetar a semana parcial', () => {
  const values: [string, number][] = [
    ['2026-09-13', 22],
    ['2026-09-14', 83],
    ['2026-09-21', 60],
    ['2026-09-28', 33],
    ['2026-10-01', 28],
    ['2026-10-05', 59],
    ['2026-10-12', 54],
    ['2026-10-19', 66],
    ['2026-10-26', 40],
  ];
  const p = agregarEstatisticas(
    values.map(([dia, novos]) => ({ dia, novos, excluidos: dia === '2026-09-13' ? 2 : 0 })),
    new Date('2026-10-30T16:18:10Z'),
  );
  expect(p.total).toBe(445);
  expect(p.excluidos).toBe(2);
  expect(p.meses.at(-2)?.novos).toBe(198);
  expect(p.meses.at(-1)?.novos).toBe(247);
  expect(p.semanas.map((s) => s.novos)).toEqual([0, 0, 0, 0, 22, 83, 60, 61, 59, 54, 66, 40]);
  expect(p.semanas.map((s) => s.media4Semanas)).toEqual([
    0, 0, 0, 0, 5.5, 26.25, 41.25, 56.5, 65.75, 58.5, 60, 54.75,
  ]);
  expect(p.semanas.at(-1)?.variacaoPct).toBe(-39.39);
});
