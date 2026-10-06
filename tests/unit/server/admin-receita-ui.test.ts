import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PagamentosTabs } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentosTabs.js';
import {
  ReceitaCabecalho,
  ReceitaPainel,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/receita/ReceitaPainel.js';
import type { ReceitaPainelData } from '../../../apps/eunenem-server/pages/components/eunenem/admin/receita/types.js';
import {
  agregarDias,
  type DiaPainel,
  gradePainel,
} from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

/**
 * aperture-zn5cm — aba Receita EuNeném 1b, renderização (sem browser, sem
 * banco).
 *
 * Prova o que a tela DIZ: os dois KPIs com Tarifas e Recebido e as
 * comparações, 12 meses com o corrente parcial, semanas do mês com a corrente
 * em destaque e as futuras com "—", as duas notas de definição, e o aviso
 * compacto que só existe quando há algo a conferir.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

function dia(d: string, tarifas: number, recebido: number, cancelado = 0): DiaPainel {
  return {
    dia: d,
    tarifas: { registradoCents: tarifas, canceladoCents: 0 },
    recebido: { registradoCents: recebido, canceladoCents: cancelado },
  };
}

const ZERO = { registradoCents: 0, canceladoCents: 0 };

function painel(
  hoje = '2026-10-05',
  dias: DiaPainel[] = [
    dia('2026-09-10', 389_300, 7_786_000),
    dia('2026-09-29', 81_300, 1_650_400),
    dia('2026-10-02', 51_200, 1_039_400),
    dia('2026-10-05', 7_200, 140_400),
    dia('2026-08-15', 366_750, 7_481_700),
  ],
  overrides: Partial<ReceitaPainelData> = {},
): ReceitaPainelData {
  const grade = gradePainel(hoje);
  const agregado = agregarDias(grade, dias);
  return {
    snapshotAt: '2026-10-05T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    hoje,
    janela: grade.janela,
    kpis: agregado.kpis,
    meses: [...agregado.meses],
    semanas: [...agregado.semanas],
    diferencaConciliacao: { tarifas: ZERO, recebido: ZERO },
    inconsistencias: {
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    },
    ...overrides,
  };
}

function render(data: ReceitaPainelData): string {
  return renderToStaticMarkup(React.createElement(ReceitaPainel, { data }));
}

function texto(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML do primeiro elemento com o data-testid dado, até `fim`. */
function trecho(html: string, testId: string, fim = '</li>'): string {
  const inicio = html.indexOf(`data-testid="${testId}"`);
  if (inicio < 0) throw new Error(`sem ${testId}`);
  return html.slice(inicio, html.indexOf(fim, inicio));
}

describe('Receita 1b — cabeçalho', () => {
  it('título, subtítulo e data de hoje em São Paulo', () => {
    const t = texto(
      renderToStaticMarkup(React.createElement(ReceitaCabecalho, { hoje: '2026-10-05' })),
    );
    expect(t).toContain('Receita EuNeném');
    expect(t).toContain('Taxas da plataforma menos cancelamentos.');
    expect(t).toContain('Atualizado 05/10/2026 · horário de São Paulo');
  });
});

describe('Receita 1b — KPIs', () => {
  const html = render(painel());

  it('mês atual: até hoje, com setembro inteiro como comparação', () => {
    const t = texto(trecho(html, 'receita-kpi-mes', '</article>'));
    expect(t).toMatch(
      /^.*Mês atual 01\/10 – 05\/10 Tarifas EuNeném R\$ 584,00 Setembro: R\$ 4\.706,00/,
    );
    expect(t).toContain('Recebido no banco R$ 11.798,00 Setembro: R$ 94.364,00');
  });

  it('semana atual: semana inteira, com a semana anterior inteira (atravessa o mês)', () => {
    const t = texto(trecho(html, 'receita-kpi-semana', '</article>'));
    expect(t).toContain('Semana atual 05 – 11/10');
    expect(t).toContain('Tarifas EuNeném R$ 72,00 Semana anterior: R$ 1.325,00');
    expect(t).toContain('Recebido no banco R$ 1.404,00 Semana anterior: R$ 26.898,00');
  });
});

describe('Receita 1b — barras', () => {
  const html = render(painel());

  it('12 meses, só o corrente parcial, com valores compactos e título completo', () => {
    expect(html.match(/data-testid="receita-mes"/g)).toHaveLength(12);
    expect(html.match(/data-parcial="true"/g)).toHaveLength(1);
    expect(html).toContain('data-mes="2026-10-01" data-parcial="true"');
    expect(html.replace(/\u00a0/g, ' ')).toContain(
      'title="outubro 2026 (parcial) · tarifas R$ 584,00 · recebido R$ 11.798,00"',
    );
    expect(texto(html)).toContain('últimos 12 meses · outubro em andamento');
    expect(texto(trecho(html, 'receita-mes'))).toContain('R$ 0');
    expect(texto(html)).toContain('R$ 94,4 mil R$ 4,7 mil');
  });

  it('cada série tem a própria escala: o maior mês de cada uma chega ao topo', () => {
    // Setembro tem o maior valor nas duas séries: grupo a 84%, as duas a 100%.
    const setembro = trecho(html, 'receita-mes" data-mes="2026-09-01');
    expect(setembro).toContain('height:84.00%');
    expect(setembro.match(/height:100\.00%/g)).toHaveLength(2);
  });

  it('semanas de outubro: passada, atual em destaque e futuras com "—"', () => {
    expect(texto(html)).toContain('Semanas de outubro');
    expect(html.match(/data-testid="receita-semana"/g)).toHaveLength(5);
    expect(html.match(/data-estado="futura"/g)).toHaveLength(3);
    const primeira = texto(trecho(html, 'receita-semana" data-de="2026-10-01'));
    expect(primeira).toMatch(/^.*R\$ 10\.394,00 R\$ 512,00/);
    const futura = trecho(html, 'receita-semana" data-de="2026-10-12');
    expect(futura).toContain('ainda não começou');
    expect(futura).toContain('border-dashed');
    expect(texto(futura)).toMatch(/> —$/);
    const t = texto(html);
    expect(t).toContain('01–04/10 qui a dom');
    expect(t).toContain('05–11/10 esta semana');
    expect(t).toContain('26–31/10');
  });

  it('semana atual e mês corrente usam o tom claro', () => {
    const atual = trecho(html, 'receita-semana" data-de="2026-10-05');
    expect(atual).toContain('bg-lilac-soft');
    expect(atual).toContain('bg-blue-soft');
    const outubro = trecho(html, 'receita-mes" data-mes="2026-10-01');
    expect(outubro).toContain('bg-lilac-soft');
  });
});

describe('Receita 1b — notas e aviso', () => {
  it('as duas definições ficam no rodapé', () => {
    const t = texto(render(painel()));
    expect(t).toContain(
      'Tarifas EuNeném: taxas registradas na data do pagamento aprovado, menos cancelamentos na data em que ocorreram.',
    );
    expect(t).toContain(
      'Recebido no banco: soma dos pagamentos aprovados, menos estornos. É uma estimativa: o custo do provedor e o valor que de fato caiu na conta não são registrados.',
    );
  });

  it('o rodapé declara que estorno parcial, disputa e chargeback ficam fora', () => {
    const t = texto(render(painel()));
    expect(t).toContain(
      'Estornos parciais, disputas e chargebacks não são registrados e ficam fora.',
    );
  });

  it('diferença de conciliação mostra registro e cancelamento separados, por série', () => {
    const html = render(
      painel(undefined, undefined, {
        diferencaConciliacao: {
          tarifas: { registradoCents: 100, canceladoCents: 100 },
          recebido: { registradoCents: 0, canceladoCents: -250 },
        },
      }),
    );
    const t = texto(trecho(html, 'receita-aviso-conciliacao', '</p>'));
    expect(t).toContain('tarifas: R$ 1,00 em registros e R$ 1,00 em cancelamentos');
    expect(t).toContain('recebido: R$ 0,00 em registros e -R$ 2,50 em cancelamentos');
    expect(t).not.toContain('diferença de R$ 0,00');
  });

  it('só a série divergente aparece na diferença de conciliação', () => {
    const html = render(
      painel(undefined, undefined, {
        diferencaConciliacao: {
          tarifas: ZERO,
          recebido: { registradoCents: 300, canceladoCents: 0 },
        },
      }),
    );
    const t = texto(trecho(html, 'receita-aviso-conciliacao', '</p>'));
    expect(t).toContain('recebido: R$ 3,00 em registros e R$ 0,00 em cancelamentos');
    expect(t).not.toContain('tarifas:');
  });

  it('sem nada a conferir, não há aviso', () => {
    expect(render(painel())).not.toContain('receita-aviso');
  });

  it('inconsistências e diferença de conciliação aparecem no aviso compacto', () => {
    const html = render(
      painel(undefined, undefined, {
        diferencaConciliacao: {
          tarifas: { registradoCents: 100, canceladoCents: 0 },
          recebido: ZERO,
        },
        inconsistencias: {
          estornadoSemCancelamento: { count: 2, cents: 1_500 },
          canceladoSemEstorno: { count: 1, cents: 700 },
        },
      }),
    );
    expect(html).toContain('role="status" aria-label="Conferir"');
    expect(texto(trecho(html, 'receita-aviso-conciliacao', '</p>'))).toContain(
      'tarifas: R$ 1,00 em registros e R$ 0,00 em cancelamentos',
    );
    expect(texto(trecho(html, 'receita-aviso-estornado', '</p>'))).toContain(
      '2 taxa(s) de pagamento estornado sem data de cancelamento (R$ 15,00)',
    );
    expect(texto(trecho(html, 'receita-aviso-cancelado', '</p>'))).toContain(
      '1 taxa(s) cancelada(s) com pagamento não estornado (R$ 7,00)',
    );
  });

  it('resultado negativo aparece como negativo', () => {
    const html = render(painel('2026-10-05', [dia('2026-10-02', 0, 0, 50_000)]));
    expect(texto(trecho(html, 'receita-kpi-mes', '</article>'))).toContain('-R$ 500,00');
  });
});

describe('abas', () => {
  it('abas são links e marcam a página atual', () => {
    const html = renderToStaticMarkup(React.createElement(PagamentosTabs, { active: 'receita' }));
    expect(html).toContain('href="/admin/pagamentos"');
    expect(html).toContain('href="/admin/pagamentos/receita" aria-current="page"');
    expect(html).not.toContain('<button');
  });
});
