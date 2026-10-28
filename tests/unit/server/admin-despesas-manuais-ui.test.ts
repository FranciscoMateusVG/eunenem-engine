import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  DespesasManuaisLista,
  FormDespesaManual,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/despesas/DespesasManuais.js';
import { DespesasPainel } from '../../../apps/eunenem-server/pages/components/eunenem/admin/despesas/DespesasPainel.js';
import type {
  DespesaManualData,
  DespesasPainelData,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/despesas/types.js';
import {
  type DespesaManual,
  diasManuais,
  parseValorBRL,
} from '../../../apps/eunenem-server/pages/lib/despesasManuais.js';
import {
  agregarDespesas,
  type DiaCobertura,
  type DiaDespesas,
} from '../../../apps/eunenem-server/pages/lib/despesasPainel.js';
import { gradePainel } from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

/**
 * aperture-0ngn4 — despesas recorrentes/manuais, renderização (sem browser,
 * sem banco): a série "Recorrentes/manuais" nos KPIs e nas barras, o total
 * que a inclui, o formulário de cadastro e a lista.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const HOJE = '2026-10-05';

function texto(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trecho(html: string, testId: string, fim: string): string {
  const inicio = html.indexOf(`data-testid="${testId}"`);
  if (inicio < 0) throw new Error(`sem ${testId}`);
  return html.slice(inicio, html.indexOf(fim, inicio));
}

const SERVIDOR: DespesaManual = {
  id: 'a',
  nome: 'Servidor',
  categoria: 'Infra',
  recorrencia: 'mensal',
  diaCobranca: 4,
  inicio: '2026-08-01',
  fim: null,
  data: null,
  valores: [{ vigenteDesde: '2026-08-01', valorCents: 10_000 }],
};

function painel(
  dias: DiaDespesas[],
  cobertura: DiaCobertura[],
  manuais: DespesaManual[],
): DespesasPainelData {
  const grade = gradePainel(HOJE);
  const agregado = agregarDespesas(
    grade,
    dias,
    cobertura,
    diasManuais(manuais, { de: grade.janela.de, ate: '2026-10-06' }),
  );
  const vazia = { confirmados: 0, pendentes: 0, falhos: 0 };
  return {
    snapshotAt: '2026-10-05T15:00:00.000Z',
    timezone: 'America/Sao_Paulo',
    hoje: HOJE,
    janela: grade.janela,
    kpis: agregado.kpis,
    meses: [...agregado.meses],
    semanas: [...agregado.semanas],
    cobertura: {
      stripe: { desdeInicio: vazia, desde: '2026-09-01', ultimaLeituraEm: null },
      inter: { desdeInicio: vazia, desde: '2026-09-01', ultimaLeituraEm: null },
    },
    diferencaConciliacao: { stripeCents: 0, interCents: 0, naoVinculadasCents: 0 },
  };
}

function render(node: unknown): string {
  return renderToStaticMarkup(node);
}

describe('Despesas — série Recorrentes/manuais', () => {
  const stripe: DiaDespesas = {
    dia: '2026-10-02',
    stripeCents: 500,
    interCents: 0,
    naoVinculadas: 0,
    naoVinculadasCents: 0,
  };
  const cobStripe: DiaCobertura[] = [
    { dia: '2026-10-02', provedor: 'stripe', status: 'confirmed', pagamentos: 1 },
  ];

  it('KPI do mês mostra a coluna manual (sempre confirmada) e o total a inclui', () => {
    const html = render(
      React.createElement(DespesasPainel, { data: painel([stripe], cobStripe, [SERVIDOR]) }),
    );
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('Recorrentes/manuais R$ 100,00');
    expect(mes).toContain('Setembro: R$ 100,00');
    expect(mes).toContain('1 lançamento · confirmado');
    expect(mes).toContain('Total R$ 105,00');
  });

  it('pendência da Stripe continua deixando o total incompleto, mesmo com manuais', () => {
    const pendente: DiaCobertura[] = [
      { dia: '2026-10-02', provedor: 'stripe', status: 'pending', pagamentos: 1 },
    ];
    const html = render(
      React.createElement(DespesasPainel, { data: painel([], pendente, [SERVIDOR]) }),
    );
    const mes = texto(trecho(html, 'despesas-kpi-mes', '</article>'));
    expect(mes).toContain('Recorrentes/manuais R$ 100,00');
    expect(mes).toContain('Total R$ 100,00 observados · incompleto');
  });

  it('barra empilha a fatia manual e a legenda a nomeia; período só com manual não fica vazio', () => {
    const html = render(React.createElement(DespesasPainel, { data: painel([], [], [SERVIDOR]) }));
    expect(html).toContain('data-fatia="manual"');
    expect(texto(html)).toContain('Recorrentes/manuais');
    const setembro = trecho(html, 'despesas-mes" data-mes="2026-09-01', '</li>').replace(
      /\u00a0/g,
      ' ',
    );
    expect(setembro).toContain('manuais R$ 100,00');
    expect(setembro).toContain('data-completo="true"');
    expect(texto(setembro)).toContain('R$ 100');
  });
});

describe('Despesas manuais — formulário', () => {
  it('mensal (padrão): nome, valor, categoria, dia de cobrança 1–28, início e fim opcional', () => {
    const html = render(React.createElement(FormDespesaManual, { onSalvar: () => {}, hoje: HOJE }));
    const t = texto(html);
    expect(t).toContain('Nova despesa');
    expect(html).toContain('name="nome"');
    expect(html).toContain('name="valor"');
    expect(html).toContain('name="categoria"');
    expect(html).toMatch(
      /name="diaCobranca"[^>]*min="1"[^>]*max="28"|max="28"[^>]*name="diaCobranca"/,
    );
    expect(html).toContain('name="inicio"');
    expect(html).toContain('name="fim"');
    expect(html).not.toContain('name="data"');
    expect(t).toContain('Mensal');
    expect(t).toContain('Única');
  });

  it('única: só a data da despesa, sem dia de cobrança nem início/fim', () => {
    const html = render(
      React.createElement(FormDespesaManual, {
        onSalvar: () => {},
        hoje: HOJE,
        recorrenciaInicial: 'unica',
      }),
    );
    expect(html).toContain('name="data"');
    expect(html).not.toContain('name="diaCobranca"');
    expect(html).not.toContain('name="inicio"');
    expect(html).not.toContain('name="fim"');
  });

  it('erro do servidor aparece como alerta', () => {
    const html = render(
      React.createElement(FormDespesaManual, {
        onSalvar: () => {},
        hoje: HOJE,
        erro: 'vigencia_deve_ser_posterior_a_ultima',
      }),
    );
    expect(html).toContain('role="alert"');
  });

  it('valor em reais vira centavos; inválido é null', () => {
    expect(parseValorBRL('100')).toBe(10_000);
    expect(parseValorBRL('1.234,56')).toBe(123_456);
    expect(parseValorBRL('R$ 9,9')).toBe(990);
    expect(parseValorBRL('12.5')).toBe(1_250);
    expect(parseValorBRL('0')).toBeNull();
    expect(parseValorBRL('abc')).toBeNull();
    expect(parseValorBRL('1,234')).toBeNull();
  });
});

describe('Despesas manuais — lista', () => {
  const despesas: DespesaManualData[] = [
    {
      ...SERVIDOR,
      valores: [
        { vigenteDesde: '2026-08-01', valorCents: 10_000 },
        { vigenteDesde: '2026-11-01', valorCents: 12_000 },
      ],
      valorAtualCents: 10_000,
    },
    {
      id: 'b',
      nome: 'Domínio',
      categoria: null,
      recorrencia: 'unica',
      diaCobranca: null,
      inicio: null,
      fim: null,
      data: '2026-09-30',
      valores: [{ vigenteDesde: '2026-09-30', valorCents: 1_100 }],
      valorAtualCents: 1_100,
    },
    {
      ...SERVIDOR,
      id: 'c',
      nome: 'Ferramenta antiga',
      categoria: null,
      fim: '2026-09-30',
      valorAtualCents: 5_000,
      valores: [{ vigenteDesde: '2026-08-01', valorCents: 5_000 }],
    },
  ];

  it('cada despesa com recorrência, valor vigente, vigência futura e ações só para mensal ativa', () => {
    const html = render(
      React.createElement(DespesasManuaisLista, {
        despesas,
        hoje: HOJE,
        onAlterarValor: () => {},
        onEncerrar: () => {},
        onExcluir: () => {},
      }),
    );
    const servidor = texto(trecho(html, 'despesa-manual-a', '</li>'));
    expect(servidor).toContain('Servidor');
    expect(servidor).toContain('Infra');
    expect(servidor).toContain('mensal · todo dia 4 · desde 01/08/2026');
    expect(servidor).toContain('R$ 100,00');
    expect(servidor).toContain('R$ 120,00 a partir de 01/11/2026');
    expect(servidor).toContain('Alterar valor');
    expect(servidor).toContain('Encerrar');
    expect(servidor).toContain('Excluir');

    const dominio = texto(trecho(html, 'despesa-manual-b', '</li>'));
    expect(dominio).toContain('única · 30/09/2026');
    expect(dominio).toContain('R$ 11,00');
    expect(dominio).not.toContain('Alterar valor');
    expect(dominio).not.toContain('Encerrar');
    expect(dominio).toContain('Excluir');

    const antiga = texto(trecho(html, 'despesa-manual-c', '</li>'));
    expect(antiga).toContain('até 30/09/2026');
    expect(antiga).toContain('encerrada');
    expect(antiga).not.toContain('Encerrar');
    expect(antiga).toContain('Excluir');
  });

  it('sem despesas: diz isso', () => {
    const html = render(
      React.createElement(DespesasManuaisLista, {
        despesas: [],
        hoje: HOJE,
        onAlterarValor: () => {},
        onEncerrar: () => {},
        onExcluir: () => {},
      }),
    );
    expect(texto(html)).toContain('Nenhuma despesa recorrente ou manual cadastrada.');
  });
});
