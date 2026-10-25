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
  expect(html).toContain('Faltam');
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
