import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { LucroGraficos } from '../../../apps/eunenem-server/pages/components/eunenem/admin/receita/LucroGraficos.js';

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
it('renderiza negativo abaixo do zero, incompleto e ausência sem inventar lucro', () => {
  const html = renderToStaticMarkup(
    React.createElement(LucroGraficos, {
      data: {
        meses: [
          { de: '2026-08-01', ate: '2026-09-01', valorCents: null, estado: 'sem_dados' },
          { de: '2026-09-01', ate: '2026-10-01', valorCents: -250, estado: 'incompleto' },
        ],
        semanas: [
          {
            de: '2026-10-01',
            ate: '2026-10-05',
            valorCents: 300,
            estado: 'completo',
            metaRecorrenteCents: 500,
            faltamCents: 200,
          },
        ],
      },
    }),
  );
  expect(html).toContain('sem dados de despesa');
  expect(html).toContain('observado · incompleto');
  expect(html).toContain('data-negative="true"');
  expect(html).toContain('top:50%');
  expect(html).toContain('2,50');
  expect(html).toContain('Lucro líquido por mês');
  expect(html).toContain('Lucro líquido por semana');
  expect(html).toContain('Meta para se pagar:');
  expect(html).not.toContain('data-weekly-target');
  expect(html).toContain('até hoje');
  expect(html).toContain('Meta não atingida');
  expect(html).toContain('Faltam');
  expect(html).toContain('Lucro observado');
  expect(html).toContain('semanas do mês corrente podem ser recalculadas');
});

it('não mostra faltam zero quando meta atingida ou inexistente', () => {
  for (const [meta, text] of [
    [500, 'Meta atingida ✓'],
    [0, 'Sem custo fixo nesta semana'],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(LucroGraficos, {
        data: {
          meses: [],
          semanas: [
            {
              de: '2026-10-01',
              ate: '2026-10-05',
              valorCents: 300,
              estado: 'completo',
              metaRecorrenteCents: meta,
              faltamCents: 0,
            },
          ],
        },
      }),
    );
    expect(html).toContain(text);
    expect(html).not.toContain('Faltam');
  }
});

it('mostra status por semana encerrada, negativa e atual parcial sem tratar futuro como atingido', () => {
  const html = renderToStaticMarkup(
    React.createElement(LucroGraficos, {
      data: {
        meses: [],
        semanas: [
          {
            de: '2026-10-05',
            ate: '2026-10-12',
            valorCents: 36986,
            estado: 'completo',
            metaRecorrenteCents: 99724,
            faltamCents: 0,
            parcial: false,
          },
          {
            de: '2026-10-12',
            ate: '2026-10-19',
            valorCents: -200,
            estado: 'completo',
            metaRecorrenteCents: 500,
            faltamCents: 200,
            parcial: false,
          },
          {
            de: '2026-10-19',
            ate: '2026-10-26',
            valorCents: 300,
            estado: 'incompleto',
            metaRecorrenteCents: 500,
            faltamCents: 0,
            parcial: true,
          },
          {
            de: '2026-10-26',
            ate: '2026-11-01',
            valorCents: null,
            estado: 'futuro',
            metaRecorrenteCents: 500,
          },
        ],
      },
    }),
  );
  expect(html.match(/Meta atingida ✓/g)).toHaveLength(2);
  expect(html.match(/Meta não atingida/g)).toHaveLength(1);
  expect(html).toContain('semana em andamento (parcial)');
  expect(html).toContain('período futuro');
  expect(html).toContain('Lucro observado: R$');
});
