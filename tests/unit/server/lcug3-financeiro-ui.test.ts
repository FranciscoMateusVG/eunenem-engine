import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  FinanceiroSecao,
  horasOuNaoMedido,
  textoHoras,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/FinanceiroSecao.js';
import type { FinanceiroData } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/types.js';

/** aperture-lcug3 — o que a seção Financeiro DIZ. */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');

const cob = (nota: string) => ({ nota, parcial: true, denominador: 10, observados: 7 });
const data = {
  hoje: '2026-11-01',
  snapshotAt: '2026-11-01T15:00:00.000Z',
  periodo: { de: '2026-09-01', ate: '2026-11-02' },
  meses: [],
  semanas: [],
  margem: {
    taxasCents: 120_000,
    reversoesCents: 5_000,
    custosCents: 30_000,
    margemContribuicaoCents: 85_000,
    p25Cents: 1_000,
    p50Cents: 4_000,
    p90Cents: null,
    listas: 9,
    pagamentos: 40,
    pagamentosComCusto: 28,
    cobertura: cob('NOTA-MARGEM'),
  },
  repasses: {
    solicitadoAteTransferido: { p50Horas: 18, p95Horas: 96, observados: 12 },
    aprovadoAteTransferido: { p50Horas: null, p95Horas: null, observados: 0 },
    solicitadoAteAceito: { p50Horas: 6, p95Horas: 30, observados: 9 },
    coberturaAceite: cob('NOTA-ACEITE'),
    aging: [
      { estado: 'solicitado', faixa: '0_2d', quantidade: 2, valorCents: 30_000 },
      { estado: 'solicitado', faixa: 'mais_30d', quantidade: 1, valorCents: 9_900 },
      { estado: 'estado_novo', faixa: '3_7d', quantidade: 1, valorCents: 100 },
    ],
    confirmadosSemMarco: 2,
    cobertura: cob('NOTA-REPASSES'),
  },
  exposicao: {
    medBloqueadoCents: 10_000,
    medLiberadoCents: 0,
    medDevolvidoCents: 2_000,
    estornosStripeConfirmadosCents: 3_000,
    devolucoesPixConfirmadasCents: 4_000,
    jaRepassadoEmPagamentosContestadosCents: 8_000,
    recuperadoPelaPlataformaCents: null,
    cobertura: cob('NOTA-EXPOSICAO'),
  },
} as unknown as FinanceiroData;

describe('Financeiro', () => {
  const html = renderToStaticMarkup(React.createElement(FinanceiroSecao, { data })) as string;

  it('margem com distribuição e nota de cobertura', () => {
    expect(html).toMatch(/R\$\s850,00/);
    expect(html).toContain('não é lucro líquido');
    expect(html).toContain('NOTA-MARGEM');
    expect(html).toContain('7 de 10 pagamentos com o dado');
  });

  it('prazo principal é o aceite do banco, rotulado como não sendo crédito', () => {
    expect(html).toContain('Prazo até o banco aceitar');
    expect(html).toContain('6 h');
    expect(html).toContain('aceite do banco, não confirmação de crédito');
    expect(html).toContain('NOTA-ACEITE');
    // Prazo estrito sem confirmações: não medido, não "—".
    expect(html).toMatch(/Aprovação → crédito confirmado<\/div><div[^>]*>não medido</);
  });

  it('prazos em horas/dias e aging por estado × idade', () => {
    expect(html).toContain('18 h');
    expect(html).toContain('4 dias');
    expect(html.match(/data-testid="financeiro-aging"/g)).toHaveLength(2);
    expect(html).toContain('Solicitado');
    // Estado desconhecido aparece como veio, sem quebrar.
    expect(html).toContain('estado_novo');
    expect(html).toContain('2 repasses confirmados sem data de pedido');
    expect(html).toContain('NOTA-REPASSES');
  });

  it('exposição: uma linha por categoria, sem total, recuperado não medido', () => {
    expect(html.match(/data-testid="financeiro-exposicao"/g)).toHaveLength(7);
    expect(html).toContain('não medido');
    expect(html).not.toMatch(/Total/);
    expect(html).toContain('NOTA-EXPOSICAO');
  });
});

it('horasOuNaoMedido', () => {
  expect(horasOuNaoMedido({ p50Horas: null, p95Horas: null, observados: 0 })).toBe('não medido');
  expect(horasOuNaoMedido({ p50Horas: 12, p95Horas: 72, observados: 3 }, 'p95Horas')).toBe(
    '3 dias',
  );
});

it('textoHoras', () => {
  expect(textoHoras(null)).toBe('—');
  expect(textoHoras(5.5)).toBe('5,5 h');
  expect(textoHoras(60)).toBe('2,5 dias');
});
