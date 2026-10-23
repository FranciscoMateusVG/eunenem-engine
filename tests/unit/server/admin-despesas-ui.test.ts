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
  type DiaDespesas,
} from '../../../apps/eunenem-server/pages/lib/despesasPainel.js';
import { gradePainel } from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

/**
 * aperture-5qoz0 PR3 — aba Despesas, renderização (sem browser, sem banco).
 *
 * Prova o que a tela DIZ: KPIs Stripe (cartão), Inter (PIX) e total; barras
 * de 12 meses e semanas; cobertura com pendente/falho escritos por extenso
 * (nunca R$ 0 no lugar de pendente); tarifas não vinculadas visíveis e fora
 * do total.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

function dia(d: string, stripe: number, inter: number, nv = 0, nvCents = 0): DiaDespesas {
  return {
    dia: d,
    stripeCents: stripe,
    interCents: inter,
    naoVinculadas: nv,
    naoVinculadasCents: nvCents,
  };
}

function painel(overrides: Partial<DespesasPainelData> = {}): DespesasPainelData {
  const hoje = '2026-10-05';
  const grade = gradePainel(hoje);
  const agregado = agregarDespesas(grade, [
    dia('2026-09-10', 12_340, 2_970),
    dia('2026-09-29', 1_000, 99),
    dia('2026-10-02', 2_500, 198, 1, 150),
    dia('2026-10-05', 467, 99, 2, 300),
  ]);
  return {
    snapshotAt: '2026-10-05T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    hoje,
    janela: grade.janela,
    kpis: agregado.kpis,
    meses: [...agregado.meses],
    semanas: [...agregado.semanas],
    cobertura: {
      stripe: {
        disponivel: true,
        mesAtual: { confirmados: 7, pendentes: 3, falhos: 1 },
        semanaAtual: { confirmados: 1, pendentes: 2, falhos: 0 },
        desdeInicio: { confirmados: 37, pendentes: 3, falhos: 1 },
        desde: '2026-09-01',
        ultimaLeituraEm: '2026-10-05T14:55:00.000Z',
      },
      inter: { disponivel: false, ultimaLeituraEm: null },
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

describe('Despesas — cabeçalho e abas', () => {
  it('título e data de hoje em São Paulo', () => {
    const t = texto(
      renderToStaticMarkup(React.createElement(DespesasCabecalho, { hoje: '2026-10-05' })),
    );
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
    expect(texto(html)).toContain('Despesas');
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

  it('mês atual: Stripe, Inter e total, com setembro como comparação', () => {
    const t = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(t).toContain('Mês atual 01/10 – 05/10');
    expect(t).toContain('Stripe (cartão) R$ 29,67 observados Setembro: R$ 133,40');
    expect(t).toContain('Inter (PIX) R$ 2,97 observados Setembro: R$ 30,69');
    expect(t).toContain('Total R$ 32,64 observados · incompleto Setembro: R$ 164,09');
  });

  it('semana atual: semana inteira, comparada com a anterior', () => {
    const t = texto(trecho(html, 'despesas-kpi-semana', '</article>'));
    expect(t).toContain('Semana atual 05 – 11/10');
    expect(t).toContain('Stripe (cartão) R$ 4,67 observados Semana anterior: R$ 35,00');
    expect(t).toContain('Total R$ 5,66 observados · incompleto Semana anterior: R$ 37,97');
  });

  it('pendentes e falhos aparecem por extenso ao lado do valor, nunca como zero', () => {
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('7 confirmadas · 3 pendentes · 1 falha');
    const semana = texto(trecho(html, 'despesas-kpi-semana', '</article>'));
    expect(semana).toContain('1 confirmada · 2 pendentes');
    expect(mes).toContain('Inter: cobertura ainda não medida');
  });

  it('tarifas não vinculadas aparecem com contagem e soma, fora do total', () => {
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('Não vinculadas a pagamento: 3 tarifas · R$ 4,50 (fora do total)');
    const semana = texto(trecho(html, 'despesas-kpi-semana', '</article>'));
    expect(semana).toContain('Não vinculadas a pagamento: 2 tarifas · R$ 3,00 (fora do total)');
  });
});

/** Texto do valor principal de cada coluna do cartão (sem comparação nem cobertura). */
function valores(html: string, cartao: string): Record<string, string> {
  const card = trecho(html, cartao, '</article>');
  const out: Record<string, string> = {};
  for (const serie of ['stripe', 'inter', 'total']) {
    const coluna = trecho(card, `despesas-kpi-${serie}`, '</div>');
    out[serie] = texto(trecho(coluna, 'despesas-kpi-valor', '</p>').replace(/^[^>]*>/, ''));
  }
  return out;
}

describe('Despesas — valor incompleto nunca aparece como zero', () => {
  function semObservado(pendentes: number, falhos = 0): DespesasPainelData {
    const grade = gradePainel('2026-10-05');
    const agregado = agregarDespesas(grade, []);
    const base = painel();
    const c = { confirmados: 0, pendentes, falhos };
    return {
      ...base,
      kpis: agregado.kpis,
      meses: [...agregado.meses],
      semanas: [...agregado.semanas],
      cobertura: {
        ...base.cobertura,
        stripe: {
          disponivel: true,
          mesAtual: c,
          semanaAtual: c,
          desdeInicio: c,
          desde: '2026-09-01',
          ultimaLeituraEm: null,
        },
      },
    };
  }

  it('0 observado + 1 pendente: "— pendente" em Stripe e Total, nunca R$ 0,00', () => {
    const html = render(semObservado(1));
    for (const cartao of ['despesas-kpi-mes', 'despesas-kpi-semana']) {
      const t = texto(trecho(html, cartao, '</article>'));
      expect(t).not.toMatch(/(Stripe \(cartão\)|Total) R\$ 0,00/);
      const v = valores(html, cartao);
      expect(v.stripe).toBe('— pendente');
      expect(v.total).toBe('— pendente');
      expect(v.inter).toBe('— não medido');
      for (const valor of Object.values(v)) expect(valor).not.toMatch(/R\$\s0,00/);
    }
  });

  it('0 observado + só falhas: "— falha"', () => {
    expect(valores(render(semObservado(0, 2)), 'despesas-kpi-mes').stripe).toBe('— falha');
  });

  it('com pendentes, o valor observado vem marcado como subtotal; o total como incompleto', () => {
    const v = valores(render(painel()), 'despesas-kpi-mes');
    expect(v.stripe).toBe('R$ 29,67 observados');
    expect(v.inter).toBe('R$ 2,97 observados');
    expect(v.total).toBe('R$ 32,64 observados · incompleto');
  });

  it('cobertura completa: valor sem marca', () => {
    const base = painel();
    const completo = { confirmados: 4, pendentes: 0, falhos: 0 };
    const html = render(
      painel({
        cobertura: {
          inter: { disponivel: false, ultimaLeituraEm: null },
          stripe: {
            disponivel: true,
            mesAtual: completo,
            semanaAtual: completo,
            desdeInicio: completo,
            desde: '2026-09-01',
            ultimaLeituraEm: base.cobertura.stripe.ultimaLeituraEm,
          },
        },
      }),
    );
    const v = valores(html, 'despesas-kpi-mes');
    expect(v.stripe).toBe('R$ 29,67');
    // Inter segue não medido, então o total segue incompleto.
    expect(v.total).toBe('R$ 32,64 observados · incompleto');
  });
});

describe('Despesas — barras', () => {
  const html = render(painel());

  it('12 meses, o corrente parcial, com rótulo de total e título completo', () => {
    const meses = html.match(/data-testid="despesas-mes"/g) ?? [];
    expect(meses).toHaveLength(12);
    const outubro = trecho(html, 'despesas-mes" data-mes="2026-10-01');
    expect(outubro).toContain('data-parcial="true"');
    expect(outubro.replace(/\u00a0/g, ' ')).toContain(
      'outubro 2026 (parcial) · Stripe R$ 29,67 · Inter R$ 2,97 · total R$ 32,64',
    );
  });

  it('semanas do mês: atual em destaque, futuras com "—"', () => {
    const estados = [
      ...html.matchAll(/data-testid="despesas-semana"[^>]*data-estado="(\w+)"/g),
    ].map((m) => m[1]);
    expect(estados).toEqual(['passada', 'atual', 'futura', 'futura', 'futura']);
    expect(texto(trecho(html, 'despesas-semana" data-de="2026-10-19'))).toContain('—');
  });

  it('a fatia de baixo é Stripe/total; a altura é o total numa escala única', () => {
    const setembro = trecho(html, 'despesas-mes" data-mes="2026-09-01');
    expect(setembro).toMatch(/style="height:84\.00%"/);
    // Stripe = 13.340 / 16.409 do total de setembro.
    expect(setembro).toMatch(/data-fatia="stripe"[^>]*style="height:81\.30%"/);
  });
});

describe('Despesas — cobertura e avisos', () => {
  it('bloco de cobertura: Stripe com contagens desde o início e última leitura; Inter não medida', () => {
    const t = texto(trecho(render(painel()), 'despesas-cobertura', '</section>'));
    expect(t).toContain('Cobertura');
    expect(t).toContain('Stripe (cartão) desde 01/09/2026');
    expect(t).toContain('37 confirmadas · 3 pendentes · 1 falha');
    expect(t).toContain('última leitura 05/10/2026, 11:55');
    expect(t).toContain('Inter (PIX)');
    expect(t).toContain('cobertura ainda não medida');
    expect(t).toContain('nenhuma leitura ainda');
  });

  it('sem nada pendente, diz isso; sem pagamento elegível, também', () => {
    const t = texto(
      trecho(
        render(
          painel({
            cobertura: {
              stripe: {
                disponivel: true,
                mesAtual: { confirmados: 4, pendentes: 0, falhos: 0 },
                semanaAtual: { confirmados: 0, pendentes: 0, falhos: 0 },
                desdeInicio: { confirmados: 4, pendentes: 0, falhos: 0 },
                desde: '2026-09-01',
                ultimaLeituraEm: null,
              },
              inter: { disponivel: false, ultimaLeituraEm: null },
            },
          }),
        ),
        'despesas-kpi-mes',
        '</article>',
      ),
    );
    expect(t).toContain('4 confirmadas · nenhuma pendente');
  });

  it('semana sem pagamento elegível diz isso, não "0 confirmadas"', () => {
    const base = painel();
    const t = texto(
      trecho(
        render(
          painel({
            cobertura: {
              ...base.cobertura,
              stripe: {
                disponivel: true,
                mesAtual: { confirmados: 0, pendentes: 0, falhos: 0 },
                semanaAtual: { confirmados: 0, pendentes: 0, falhos: 0 },
                desdeInicio: { confirmados: 0, pendentes: 0, falhos: 0 },
                desde: '2026-09-01',
                ultimaLeituraEm: null,
              },
            },
          }),
        ),
        'despesas-kpi-semana',
        '</article>',
      ),
    );
    expect(t).toContain('nenhum pagamento com cartão no período');
  });

  it('diferença de conciliação aparece no aviso; sem diferença, sem aviso', () => {
    expect(render(painel())).not.toContain('data-testid="despesas-aviso"');
    const t = texto(
      render(
        painel({
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
  });
});
