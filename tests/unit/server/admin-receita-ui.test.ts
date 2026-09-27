import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ReceitaPainel,
  ReceitaPeriodoFiltro,
} from '../../../apps/eunenem-server/pages/AdminReceitaPage.js';
import { PagamentosTabs } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentosTabs.js';
import {
  escalaDaSerie,
  ReceitaSerieChart,
  tetoLegivel,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/receita/ReceitaSerieChart.js';
import type { ReceitaDashboard } from '../../../apps/eunenem-server/pages/components/eunenem/admin/receita/types.js';

/**
 * aperture-9bpre — aba Receita EuNeném, renderização (sem browser, sem banco).
 *
 * Prova o que a tela DIZ: resultado negativo aparece como negativo, a tabela
 * carrega os mesmos números do gráfico, os limites da fonte ficam sempre
 * visíveis, diferença de conciliação é mostrada e nunca escondida, e nenhum
 * rótulo promete lucro ou valor líquido.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const ZERO = { taxasRegistradasCents: 0, cancelamentosCents: 0 };

function card(
  de: string,
  ate: string,
  registradas: number,
  cancelamentos: number,
): ReceitaDashboard['cards']['periodo'] {
  return {
    de,
    ate,
    taxasRegistradasCents: registradas,
    cancelamentosCents: cancelamentos,
    resultadoDeTaxasCents: registradas - cancelamentos,
    lancamentosRegistrados: registradas > 0 ? 1 : 0,
    lancamentosCancelados: cancelamentos > 0 ? 1 : 0,
    pagamentosComTaxa: registradas > 0 ? 1 : 0,
    adicionalCartao: { registradoCents: 7_000, canceladoCents: 0 },
  };
}

function dashboard(overrides: Partial<ReceitaDashboard> = {}): ReceitaDashboard {
  const total = { taxasRegistradasCents: 12_345, cancelamentosCents: 45_678 };
  return {
    snapshotAt: '2031-06-18T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    periodo: { de: '2031-01-01', ate: '2031-03-01', granularidade: 'mes' },
    cards: {
      semanaAtual: card('2031-06-16', '2031-06-23', 0, 0),
      mesAtual: card('2031-06-01', '2031-07-01', 2_500, 0),
      periodo: card('2031-01-01', '2031-03-01', 12_345, 45_678),
    },
    serie: [
      {
        inicio: '2031-01-01',
        fim: '2031-02-01',
        parcial: false,
        taxasRegistradasCents: 12_345,
        cancelamentosCents: 0,
        resultadoDeTaxasCents: 12_345,
      },
      {
        inicio: '2031-02-01',
        fim: '2031-03-01',
        parcial: false,
        taxasRegistradasCents: 0,
        cancelamentosCents: 45_678,
        resultadoDeTaxasCents: -45_678,
      },
    ],
    porCampanha: {
      rows: [
        {
          idCampanha: '10000000-0000-4000-8000-000000000001',
          titulo: 'Chá da Lia',
          campaignSlug: 'cha-da-lia',
          publicOwnerSlug: 'ana-admin',
          administrators: {
            shown: [
              {
                idConta: '12000000-0000-4000-8000-000000000001',
                displayName: 'Ana Administradora',
                email: 'ana@example.test',
                hasUserRow: true,
              },
              {
                idConta: '12000000-0000-4000-8000-000000000002',
                displayName: 'Bia Coadmin',
                email: 'bia@example.test',
                hasUserRow: true,
              },
            ],
            total: 2,
          },
          taxasRegistradasCents: 12_345,
          cancelamentosCents: 45_678,
          resultadoDeTaxasCents: -33_333,
        },
      ],
      campanhasTotal: 1,
      truncated: false,
      foraDaLista: ZERO,
    },
    porMeioProvedor: [
      {
        metodo: 'pix',
        provedor: 'nao_registrado',
        taxasRegistradasCents: 12_345,
        cancelamentosCents: 45_678,
        resultadoDeTaxasCents: -33_333,
      },
    ],
    conciliacao: {
      totalIndependente: total,
      somaSerie: total,
      somaPorCampanha: total,
      somaPorMeioProvedor: total,
      diferencas: { serie: ZERO, porCampanha: ZERO, porMeioProvedor: ZERO },
    },
    inconsistencias: {
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    },
    primeiroRegistroTaxaEm: '2030-11-02T13:00:00.000Z',
    limitesDeDados: {
      custoProvedor: 'desconhecido',
      receitaLiquida: 'desconhecida',
      estornoParcial: 'nao_refletido_no_ledger',
      disputa: 'nao_refletida_no_ledger',
      linhasSemPagamentoResolvivel: 'nao_contadas_cobertura_inconclusiva',
    },
    ...overrides,
  };
}

function render(data: ReceitaDashboard): string {
  return renderToStaticMarkup(React.createElement(ReceitaPainel, { data }));
}

/** Intl usa NBSP entre "R$" e o número; normaliza para comparar texto. */
function texto(html: string): string {
  return html.replace(/ /g, ' ').replace(/&nbsp;/g, ' ');
}

describe('ReceitaPainel — resultado e rótulos', () => {
  const html = texto(render(dashboard()));

  it('mostra resultado negativo como negativo, com explicação', () => {
    expect(html).toContain('-R$ 333,33');
    expect(html).toContain('-R$ 456,78');
    expect(html).toContain('os cancelamentos do intervalo superam as taxas registradas');
  });

  it('usa os rótulos do contrato', () => {
    expect(html).toContain('Taxas registradas');
    expect(html).toContain('Cancelamentos');
    expect(html).toContain('Resultado de taxas');
    expect(html).toContain('Receita EuNeném (taxa da plataforma)');
    expect(html).toContain('Adicional de cartão (repasse, não é receita)');
  });

  it('nunca promete lucro nem valor líquido', () => {
    expect(html).not.toMatch(/lucro/i);
    expect(html).not.toMatch(/l[ií]quid/i);
    expect(html).not.toMatch(/margem/i);
  });

  it('adicional de cartão fica em linha própria e não altera o resultado', () => {
    expect(html).toContain('registrado R$ 70,00');
    // Período: 123,45 − 456,78 = −333,33, sem os 70,00 do adicional.
    expect(html).not.toContain('-R$ 263,33');
    expect(html).not.toContain('R$ 193,45');
  });

  it('intervalo sem evento diz isso em vez de parecer um zero qualquer', () => {
    expect(html).toContain('Nenhuma taxa registrada ou cancelada neste intervalo.');
  });

  it('intervalos dos cards mostram o último dia incluído', () => {
    expect(html).toContain('01/01/2031 a 28/02/2031');
    expect(html).toContain('16/06/2031 a 22/06/2031');
  });
});

describe('ReceitaPainel — limites da fonte sempre visíveis', () => {
  it('declara o que o ledger não sabe, mesmo com dados sãos', () => {
    const html = texto(render(dashboard()));
    expect(html).toContain('O que esta tela não mostra');
    expect(html).toContain('Estorno parcial e contestação de cartão não alteram o ledger');
    expect(html).toContain('nenhum valor é estimado');
    expect(html).toContain('O custo cobrado pelo provedor');
    expect(html).toContain('não é contada');
    expect(html).toContain('inconclusiva — não é zero');
    expect(html).toContain('Correções históricas ainda podem alterar');
    expect(html).toContain('Primeiro registro de taxa no ledger: 02/11/2030');
    expect(html).toContain('não prova que todo pagamento antigo tem taxa');
    expect(html).toContain('Leitura única de 18/06/2031');
  });

  it('sem nenhum registro, diz que não há registro — não inventa data', () => {
    const html = texto(render(dashboard({ primeiroRegistroTaxaEm: null })));
    expect(html).toContain('Ainda não há registro de taxa no ledger.');
    expect(html).not.toContain('Primeiro registro de taxa no ledger:');
  });
});

describe('ReceitaPainel — gráfico e tabela equivalente', () => {
  const html = texto(render(dashboard()));

  it('cada intervalo do gráfico anuncia os três valores', () => {
    expect(html).toContain(
      'aria-label="jan/2031; Taxas registradas R$ 123,45; Cancelamentos R$ 0,00; Resultado de taxas R$ 123,45"',
    );
    expect(html).toContain(
      'aria-label="fev/2031; Taxas registradas R$ 0,00; Cancelamentos R$ 456,78; Resultado de taxas -R$ 456,78"',
    );
  });

  it('a tabela traz os mesmos intervalos e valores, mais a soma', () => {
    const tabela = html.slice(html.indexOf('Mesmos valores do gráfico'));
    expect(tabela).toContain('jan/2031');
    expect(tabela).toContain('fev/2031');
    expect(tabela).toContain('R$ 123,45');
    expect(tabela).toContain('R$ 456,78');
    expect(tabela).toContain('-R$ 456,78');
    expect(tabela).toContain('Soma da série');
    expect(tabela).toContain('-R$ 333,33');
  });

  it('o gráfico é uma única parada de tabulação com navegação por setas', () => {
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(html).toContain('Use as setas para percorrer');
  });

  it('legenda nomeia as séries e a direção de cada uma', () => {
    expect(html).toContain('Taxas registradas (acima da linha)');
    expect(html).toContain('Cancelamentos (abaixo da linha)');
  });

  it('barra de cancelamento desce a partir da linha de base', () => {
    // Escala 200,00 acima e 500,00 abaixo ⇒ base a 200/700 do topo.
    expect(escalaDaSerie(dashboard().serie)).toEqual({ acima: 20_000, abaixo: 50_000 });
    const chart = renderToStaticMarkup(
      React.createElement(ReceitaSerieChart, {
        serie: dashboard().serie,
        granularidade: 'mes',
      }),
    );
    const base = (20_000 / 70_000) * 100;
    expect(chart).toContain(`top:${base}%`);
    expect(chart).toContain(`height:${(45_678 / 70_000) * 100}%`);
    expect(chart).toContain(`height:${(12_345 / 70_000) * 100}%`);
    // Ponto do resultado negativo fica ABAIXO da base.
    expect(chart).toContain(`top:${base + (45_678 / 70_000) * 100}%`);
  });

  it('teto do eixo arredonda para 1, 2 ou 5 vezes potência de dez', () => {
    expect(tetoLegivel(0)).toBe(0);
    expect(tetoLegivel(1)).toBe(1);
    expect(tetoLegivel(12_345)).toBe(20_000);
    expect(tetoLegivel(45_678)).toBe(50_000);
    expect(tetoLegivel(50_000)).toBe(50_000);
    expect(tetoLegivel(50_001)).toBe(100_000);
  });

  it('período sem eventos: aviso no lugar do gráfico e tabela com zeros de fato', () => {
    const vazio = dashboard({
      cards: {
        semanaAtual: card('2031-06-16', '2031-06-23', 0, 0),
        mesAtual: card('2031-06-01', '2031-07-01', 0, 0),
        periodo: card('2031-01-01', '2031-03-01', 0, 0),
      },
      serie: dashboard().serie.map((b) => ({
        ...b,
        taxasRegistradasCents: 0,
        cancelamentosCents: 0,
        resultadoDeTaxasCents: 0,
      })),
      porCampanha: { rows: [], campanhasTotal: 0, truncated: false, foraDaLista: ZERO },
      porMeioProvedor: [],
      conciliacao: {
        totalIndependente: ZERO,
        somaSerie: ZERO,
        somaPorCampanha: ZERO,
        somaPorMeioProvedor: ZERO,
        diferencas: { serie: ZERO, porCampanha: ZERO, porMeioProvedor: ZERO },
      },
    });
    const out = texto(render(vazio));
    expect(out).toContain('não há o que desenhar');
    expect(out).toContain('Nenhuma campanha teve taxa registrada ou cancelada neste período.');
    expect(out).toContain('jan/2031');
    expect(out).not.toContain('role="alert"');
  });
});

describe('ReceitaPainel — decomposições', () => {
  it('campanha aparece uma vez, com os coadmins como atributo', () => {
    const html = texto(render(dashboard()));
    expect(html.match(/Chá da Lia/g)).toHaveLength(1);
    expect(html).toContain('href="/admin/usuario/12000000-0000-4000-8000-000000000001"');
    expect(html).toContain('href="/admin/usuario/12000000-0000-4000-8000-000000000002"');
    expect(html).toContain('href="/pagina/ana-admin/cha-da-lia"');
    expect(html).toContain('os valores não são divididos entre eles');
    expect(html).toContain('Todas as campanhas (1)');
  });

  it('provedor ausente aparece nomeado, não some', () => {
    const html = texto(render(dashboard()));
    expect(html).toContain('provedor não registrado');
    expect(html).toContain('PIX');
  });

  it('lista truncada mostra o que ficou de fora e o total de todas', () => {
    const html = texto(
      render(
        dashboard({
          porCampanha: {
            ...dashboard().porCampanha,
            campanhasTotal: 101,
            truncated: true,
            foraDaLista: { taxasRegistradasCents: 9_900, cancelamentosCents: 100 },
          },
        }),
      ),
    );
    expect(html).toContain('Fora desta lista (100 campanhas)');
    expect(html).toContain('R$ 99,00');
    expect(html).toContain('R$ 98,00');
    expect(html).toContain('Todas as campanhas (101)');
    expect(html).toContain('o total cobre todas');
  });
});

describe('ReceitaPainel — conciliação e inconsistências', () => {
  it('dados conciliados não geram alerta', () => {
    const html = render(dashboard());
    expect(html).not.toContain('Diferença não conciliada');
    expect(html).not.toContain('Linhas incoerentes no período');
    expect(html).not.toContain('role="alert"');
  });

  it('diferença é mostrada como está, nomeando a origem', () => {
    const base = dashboard();
    const html = texto(
      render(
        dashboard({
          conciliacao: {
            ...base.conciliacao,
            diferencas: {
              serie: ZERO,
              porCampanha: { taxasRegistradasCents: 150, cancelamentosCents: -20 },
              porMeioProvedor: ZERO,
            },
          },
        }),
      ),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Diferença não conciliada');
    expect(html).toContain('soma por campanha: diferença de R$ 1,50 em taxas registradas');
    expect(html).toContain('-R$ 0,20 em cancelamentos');
    expect(html).toContain('Nenhum valor foi ajustado');
    expect(html).not.toContain('soma da série: diferença');
  });

  it('linhas incoerentes aparecem à parte, com contagem e valor', () => {
    const html = texto(
      render(
        dashboard({
          inconsistencias: {
            estornadoSemCancelamento: { count: 2, cents: 1_200 },
            canceladoSemEstorno: { count: 1, cents: 800 },
          },
        }),
      ),
    );
    expect(html).toContain('Linhas incoerentes no período');
    expect(html).toContain('2 taxa(s) de pagamento estornado sem data de cancelamento');
    expect(html).toContain('R$ 12,00');
    expect(html).toContain('1 taxa(s) cancelada(s) cujo pagamento não está estornado');
    expect(html).toContain('R$ 8,00');
    expect(html).toContain('Nenhum total foi ajustado');
  });
});

describe('abas e filtro de período', () => {
  it('abas são links e marcam a página atual', () => {
    const html = renderToStaticMarkup(React.createElement(PagamentosTabs, { active: 'receita' }));
    expect(html).toContain('aria-label="Seções de pagamentos"');
    expect(html).toMatch(/<a href="\/admin\/pagamentos"(?![^>]*aria-current)[^>]*>Pagamentos<\/a>/);
    expect(html).toMatch(
      /<a href="\/admin\/pagamentos\/receita" aria-current="page"[^>]*>Receita EuNeném<\/a>/,
    );
    expect(html).not.toContain('<button');
  });

  it('filtro tem rótulos, estado da granularidade e data final inclusiva', () => {
    const html = renderToStaticMarkup(
      React.createElement(ReceitaPeriodoFiltro, {
        periodo: { de: '2031-01-01', ate: '2031-03-01', granularidade: 'semana' },
        onAplicar: () => undefined,
        now: () => new Date('2031-06-18T15:00:00Z'),
      }),
    );
    expect(html).toContain('aria-label="Período da receita"');
    expect(html).toContain('Agrupar por');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Semana</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Mês</);
    expect(html).toContain('value="2031-01-01"');
    // ate é exclusivo no contrato; o campo mostra o último dia incluído.
    expect(html).toContain('value="2031-02-28"');
    expect(html).toContain('Até (inclusive)');
    for (const atalho of ['Últimos 12 meses', 'Últimas 12 semanas', 'Mês atual', 'Semana atual']) {
      expect(html).toContain(atalho);
    }
    expect(html).toContain('Semana de segunda a domingo');
  });
});
