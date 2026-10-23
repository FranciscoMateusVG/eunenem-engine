import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../../apps/eunenem-server/pages/App.js';
import {
  DespesasCabecalho,
  DespesasPainel,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/despesas/DespesasPainel.js';
import type { DespesasPainelData } from '../../../apps/eunenem-server/pages/components/eunenem/admin/despesas/types.js';
import { PagamentosTabs } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentosTabs.js';
import {
  agregarDespesas,
  type DiaCobertura,
  type DiaDespesas,
} from '../../../apps/eunenem-server/pages/lib/despesasPainel.js';
import { gradePainel } from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

/**
 * aperture-5qoz0 PR3 — aba Despesas, renderização (sem browser, sem banco).
 *
 * Prova o que a tela DIZ: KPIs Stripe (cartão), Inter (PIX) e total; barras
 * de 12 meses e semanas; cobertura por período exibido — valor, comparação e
 * barra de um período incompleto NUNCA aparecem como R$ 0 —; tarifas não
 * vinculadas visíveis e fora do total.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const HOJE = '2026-10-05';

function dia(d: string, stripe: number, inter: number, nv = 0, nvCents = 0): DiaDespesas {
  return {
    dia: d,
    stripeCents: stripe,
    interCents: inter,
    naoVinculadas: nv,
    naoVinculadasCents: nvCents,
  };
}

function cob(
  d: string,
  provedor: 'stripe' | 'inter',
  confirmados: number,
  pendentes = 0,
  falhos = 0,
): DiaCobertura[] {
  return [
    { dia: d, provedor, status: 'confirmed' as const, pagamentos: confirmados },
    { dia: d, provedor, status: 'pending' as const, pagamentos: pendentes },
    { dia: d, provedor, status: 'failed' as const, pagamentos: falhos },
  ].filter((c) => c.pagamentos > 0);
}

const DIAS_PADRAO = [
  dia('2026-09-10', 12_340, 2_970),
  dia('2026-09-29', 1_000, 99),
  dia('2026-10-02', 2_500, 198, 1, 150),
  dia('2026-10-05', 467, 99, 2, 300),
];

/**
 * Setembro completo nos dois provedores. Outubro: Stripe com pendências
 * (mês 7/3/1, semana 1/2/0) e Inter completo. A semana anterior (28/09–04/10)
 * herda a pendência Stripe de 02/10.
 */
const COBERTURA_PADRAO = [
  ...cob('2026-09-10', 'stripe', 30),
  ...cob('2026-09-29', 'stripe', 1),
  ...cob('2026-10-02', 'stripe', 6, 1, 1),
  ...cob('2026-10-05', 'stripe', 1, 2),
  ...cob('2026-09-10', 'inter', 20),
  ...cob('2026-09-29', 'inter', 1),
  ...cob('2026-10-02', 'inter', 2),
  ...cob('2026-10-05', 'inter', 1),
];

function painel(
  dias: DiaDespesas[] = DIAS_PADRAO,
  cobertura: DiaCobertura[] = COBERTURA_PADRAO,
  overrides: Partial<DespesasPainelData> = {},
): DespesasPainelData {
  const grade = gradePainel(HOJE);
  const agregado = agregarDespesas(grade, dias, cobertura);
  return {
    snapshotAt: '2026-10-05T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    hoje: HOJE,
    janela: grade.janela,
    kpis: agregado.kpis,
    meses: [...agregado.meses],
    semanas: [...agregado.semanas],
    cobertura: {
      stripe: {
        desdeInicio: { confirmados: 37, pendentes: 3, falhos: 1 },
        desde: '2026-09-01',
        ultimaLeituraEm: '2026-10-05T14:55:00.000Z',
      },
      inter: {
        desdeInicio: { confirmados: 24, pendentes: 0, falhos: 0 },
        desde: '2026-09-01',
        ultimaLeituraEm: null,
      },
    },
    diferencaConciliacao: { stripeCents: 0, interCents: 0, naoVinculadasCents: 0 },
    ...overrides,
  };
}

function render(data: DespesasPainelData): string {
  return renderToStaticMarkup(React.createElement(DespesasPainel, { data }));
}

function texto(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trecho(html: string, testId: string, fim = '</li>'): string {
  const inicio = html.indexOf(`data-testid="${testId}"`);
  if (inicio < 0) throw new Error(`sem ${testId}`);
  return html.slice(inicio, html.indexOf(fim, inicio));
}

/** Texto do valor principal e da comparação de cada coluna do cartão. */
function colunas(html: string, cartao: string) {
  const card = trecho(html, cartao, '</article>');
  const out: Record<string, { valor: string; comparacao: string }> = {};
  for (const serie of ['stripe', 'inter', 'total']) {
    const coluna = card.slice(card.indexOf(`data-testid="despesas-kpi-${serie}"`));
    out[serie] = {
      valor: texto(trecho(coluna, 'despesas-kpi-valor', '</p>').replace(/^[^>]*>/, '')),
      comparacao: texto(trecho(coluna, 'despesas-kpi-comparacao', '</p>').replace(/^[^>]*>/, '')),
    };
  }
  return out;
}

describe('Despesas — cabeçalho e abas', () => {
  it('título e data de hoje em São Paulo', () => {
    const t = texto(renderToStaticMarkup(React.createElement(DespesasCabecalho, { hoje: HOJE })));
    expect(t).toContain('Despesas');
    expect(t).toContain('Tarifas de processamento cobradas pelos provedores');
    expect(t).toContain('Atualizado 05/10/2026 · horário de São Paulo');
  });

  it('aba Despesas fica ao lado de Receita EuNeném e é um link com rota própria', () => {
    const html = renderToStaticMarkup(React.createElement(PagamentosTabs, { active: 'despesas' }));
    const receita = html.indexOf('href="/admin/pagamentos/receita"');
    const despesas = html.indexOf('href="/admin/pagamentos/despesas" aria-current="page"');
    expect(receita).toBeGreaterThan(-1);
    expect(despesas).toBeGreaterThan(receita);
    expect(resolveRoute('/admin/pagamentos/despesas')).toEqual({
      kind: 'admin-pagamentos-despesas',
    });
    expect(resolveRoute('/admin/pagamentos/despesas/')).toEqual({
      kind: 'admin-pagamentos-despesas',
    });
  });
});

describe('Despesas — KPIs', () => {
  const html = render(painel());

  it('mês atual: Stripe incompleto marcado, Inter completo, total incompleto; setembro completo', () => {
    const c = colunas(html, 'despesas-kpi-mes');
    expect(texto(trecho(html, 'despesas-kpi-mes', '</article>'))).toContain(
      'Mês atual 01/10 – 05/10',
    );
    expect(c.stripe).toEqual({ valor: 'R$ 29,67 observados', comparacao: 'Setembro: R$ 133,40' });
    expect(c.inter).toEqual({ valor: 'R$ 2,97', comparacao: 'Setembro: R$ 30,69' });
    expect(c.total).toEqual({
      valor: 'R$ 32,64 observados · incompleto',
      comparacao: 'Setembro: R$ 164,09',
    });
  });

  it('semana atual: a comparação com a semana anterior também carrega a própria completude', () => {
    const c = colunas(html, 'despesas-kpi-semana');
    expect(texto(trecho(html, 'despesas-kpi-semana', '</article>'))).toContain(
      'Semana atual 05 – 11/10',
    );
    expect(c.stripe).toEqual({
      valor: 'R$ 4,67 observados',
      comparacao: 'Semana anterior: R$ 35,00 observados',
    });
    expect(c.total).toEqual({
      valor: 'R$ 5,66 observados · incompleto',
      comparacao: 'Semana anterior: R$ 37,97 observados · incompleto',
    });
  });

  it('pendentes e falhas aparecem por extenso, por provedor e período', () => {
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('7 confirmadas · 3 pendentes · 1 falha');
    expect(mes).toContain('3 confirmadas · nenhuma pendente');
    const semana = texto(trecho(html, 'despesas-kpi-semana', '</article>'));
    expect(semana).toContain('1 confirmada · 2 pendentes');
  });

  it('tarifas não vinculadas aparecem com contagem e soma, fora do total', () => {
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('Não vinculadas a pagamento: 3 tarifas · R$ 4,50 (fora do total)');
  });

  it('período sem pagamento elegível diz isso, não "0 confirmadas"', () => {
    const t = texto(trecho(render(painel(DIAS_PADRAO, [])), 'despesas-kpi-semana', '</article>'));
    expect(t).toContain('nenhum pagamento com cartão no período');
    expect(t).toContain('nenhum pagamento com PIX no período');
  });
});

describe('Despesas — período incompleto nunca aparece como zero', () => {
  it('0 observado + 1 pendente no mês atual: "— pendente", nunca R$ 0,00', () => {
    const html = render(painel([], cob('2026-10-05', 'stripe', 0, 1)));
    for (const cartao of ['despesas-kpi-mes', 'despesas-kpi-semana']) {
      expect(texto(trecho(html, cartao, '</article>'))).not.toMatch(
        /(Stripe \(cartão\)|Total) R\$ 0,00/,
      );
      const c = colunas(html, cartao);
      expect(c.stripe.valor).toBe('— pendente');
      expect(c.total.valor).toBe('— pendente');
    }
  });

  it('mês anterior com 0 observado + pendente: "Setembro: — pendente", nunca "Setembro: R$ 0,00"', () => {
    const html = render(painel([dia('2026-10-05', 467, 0)], cob('2026-09-20', 'stripe', 0, 1)));
    const c = colunas(html, 'despesas-kpi-mes');
    expect(c.stripe.comparacao).not.toBe('Setembro: R$ 0,00');
    expect(c.stripe.comparacao).toBe('Setembro: — pendente');
    expect(c.total.comparacao).toBe('Setembro: — pendente');
    // Sem PIX elegível em setembro e nada observado: zero de fato.
    expect(c.inter.comparacao).toBe('Setembro: R$ 0,00');
  });

  it('só falhas: "— falha"', () => {
    const c = colunas(render(painel([], cob('2026-10-05', 'stripe', 0, 0, 2))), 'despesas-kpi-mes');
    expect(c.stripe.valor).toBe('— falha');
    expect(c.total.valor).toBe('— falha');
  });

  it('Inter pendente marca Inter e total', () => {
    const c = colunas(
      render(painel([dia('2026-10-05', 467, 99)], cob('2026-10-05', 'inter', 1, 1))),
      'despesas-kpi-mes',
    );
    expect(c.stripe.valor).toBe('R$ 4,67');
    expect(c.inter.valor).toBe('R$ 0,99 observados');
    expect(c.total.valor).toBe('R$ 5,66 observados · incompleto');
  });
});

describe('Despesas — barras', () => {
  const html = render(painel());

  it('12 meses, o corrente parcial, com rótulo de total e título completo', () => {
    expect(html.match(/data-testid="despesas-mes"/g) ?? []).toHaveLength(12);
    const outubro = trecho(html, 'despesas-mes" data-mes="2026-10-01');
    expect(outubro).toContain('data-parcial="true"');
    expect(outubro.replace(/ /g, ' ')).toContain(
      'outubro 2026 (parcial) · Stripe R$ 29,67 · Inter R$ 2,97 · total R$ 32,64 · incompleto: 3 pendentes, 1 falha',
    );
  });

  it('bucket incompleto é marcado na barra; completo não', () => {
    const outubro = trecho(html, 'despesas-mes" data-mes="2026-10-01');
    expect(outubro).toContain('data-completo="false"');
    expect(texto(outubro)).toContain('pendente');
    const setembro = trecho(html, 'despesas-mes" data-mes="2026-09-01');
    expect(setembro).toContain('data-completo="true"');
    expect(texto(setembro)).not.toContain('pendente');
  });

  it('mês sem observação mas com pendente: sem barra e sem "R$ 0", com "—" e "pendente"', () => {
    const vazio = render(painel([], cob('2026-08-15', 'stripe', 0, 1)));
    const agosto = trecho(vazio, 'despesas-mes" data-mes="2026-08-01');
    expect(agosto).toContain('data-completo="false"');
    expect(texto(agosto.replace(/^[^>]*>/, ''))).toBe('— pendente');
    // Mês sem nada elegível e sem nada observado é zero de fato.
    expect(texto(trecho(vazio, 'despesas-mes" data-mes="2026-07-01').replace(/^[^>]*>/, ''))).toBe(
      'R$ 0',
    );
  });

  it('semanas do mês: atual em destaque, futuras com "—"; semana incompleta marcada', () => {
    const estados = [
      ...html.matchAll(/data-testid="despesas-semana"[^>]*data-estado="(\w+)"/g),
    ].map((m) => m[1]);
    expect(estados).toEqual(['passada', 'atual', 'futura', 'futura', 'futura']);
    expect(texto(trecho(html, 'despesas-semana" data-de="2026-10-19'))).toContain('—');
    expect(trecho(html, 'despesas-semana" data-de="2026-10-05')).toContain('data-completo="false"');
  });

  it('a fatia de baixo é Stripe/total; a altura é o total numa escala única', () => {
    const setembro = trecho(html, 'despesas-mes" data-mes="2026-09-01');
    expect(setembro).toMatch(/style="height:80\.00%"/);
    // Stripe = 13.340 / 16.409 do total de setembro.
    expect(setembro).toMatch(/data-fatia="stripe"[^>]*style="height:81\.30%"/);
  });
});

describe('Despesas — cobertura e avisos', () => {
  it('bloco de cobertura: os dois provedores com contagens desde o início e última leitura', () => {
    const t = texto(trecho(render(painel()), 'despesas-cobertura', '</section>'));
    expect(t).toContain('Stripe (cartão) desde 01/09/2026');
    expect(t).toContain('37 confirmadas · 3 pendentes · 1 falha');
    expect(t).toContain('última leitura 05/10/2026, 11:55');
    expect(t).toContain('Inter (PIX) desde 01/09/2026');
    expect(t).toContain('24 confirmadas · nenhuma pendente');
    expect(t).toContain('nenhuma leitura ainda');
  });

  it('diferença de conciliação aparece no aviso; sem diferença, sem aviso', () => {
    expect(render(painel())).not.toContain('data-testid="despesas-aviso"');
    const t = texto(
      render(
        painel(DIAS_PADRAO, COBERTURA_PADRAO, {
          diferencaConciliacao: { stripeCents: 120, interCents: 0, naoVinculadasCents: 0 },
        }),
      ),
    );
    expect(t).toContain('A soma por dia não bate com o total independente');
    expect(t).toContain('Stripe: R$ 1,20');
    expect(t).toContain('Nenhum valor foi ajustado.');
  });

  it('a nota declara: valor observado no provedor, sem estimativa, pela data do débito', () => {
    const t = texto(render(painel()));
    expect(t).toContain('data em que o provedor debitou');
    expect(t).toContain('Nada é estimado');
    expect(t).toContain('extrato sem tarifa não confirma zero');
  });
});
