import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SeletorDeMes } from '../../../apps/eunenem-server/pages/AdminNotaFiscalPage.js';
import {
  NotaFiscalPainel,
  type NotaFiscalPrevia,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/nota-fiscal/NotaFiscalPainel.js';
import { PagamentosTabs } from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentosTabs.js';
import {
  mesAnterior,
  mesFromSearch,
  mesPadrao,
} from '../../../apps/eunenem-server/pages/lib/notaFiscalMes.js';

/**
 * aperture-dh1k7 — página da prévia da NFS-e, renderização (sem browser,
 * sem banco). Prova o que a tela DIZ: é prévia, não tem botão de emitir,
 * marca "a confirmar", diz quando o XML não está assinado e mostra o XML.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const XML =
  '<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="DPS261160621122233300018199999020260999999999"><vServ>1234.56</vServ></infDPS></DPS>';

function previa(overrides: Partial<NotaFiscalPrevia> = {}): NotaFiscalPrevia {
  return {
    mes: '2026-09',
    rotulo: 'setembro/2026',
    situacao: 'fechado',
    periodo: { de: '2026-09-01', ate: '2026-10-01' },
    timezone: 'America/Sao_Paulo',
    snapshotAt: '2026-10-05T17:30:00.000Z',
    valor: {
      taxasRegistradasCents: 150000,
      cancelamentosCents: 26544,
      resultadoDeTaxasCents: 123456,
      lancamentosRegistrados: 40,
      lancamentosCancelados: 3,
      pagamentosComTaxa: 39,
    },
    porMeioProvedor: [
      {
        metodo: 'pix',
        provedor: 'inter',
        taxasRegistradasCents: 150000,
        cancelamentosCents: 26544,
        resultadoDeTaxasCents: 123456,
      },
    ],
    adicionalCartao: { registradoCents: 0, canceladoCents: 0 },
    inconsistencias: {
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    },
    configuracao: { problemas: [] },
    avisos: ['xml_nao_assinado'],
    dps: {
      status: 'gerada',
      idDps: 'DPS261160621122233300018199999020260999999999',
      valorServico: '1234.56',
      campos: [
        {
          grupo: 'Serviço',
          tag: 'cTribNac',
          rotulo: 'Código de tributação nacional',
          valor: '100501',
          origem: 'default',
          aConfirmar: true,
          nota: 'LC 116 item 10.05',
        },
        {
          grupo: 'Valores e tributação',
          tag: 'vServ',
          rotulo: 'Valor do serviço (R$)',
          valor: '1234.56',
          origem: 'ledger',
          aConfirmar: false,
          nota: null,
        },
      ],
      xml: XML,
      assinatura: { status: 'nao_assinada', motivo: 'sem_certificado' },
    },
    ...overrides,
  };
}

function texto(html: string): string {
  return html.replace(/ /g, ' ').replace(/&nbsp;/g, ' ');
}

function render(data: NotaFiscalPrevia): string {
  return texto(renderToStaticMarkup(React.createElement(NotaFiscalPainel, { data })));
}

describe('NotaFiscalPainel', () => {
  it('mostra o valor do mês e o detalhamento', () => {
    const html = render(previa());
    expect(html).toContain('Valor da nota de setembro/2026');
    expect(html).toContain('R$ 1.234,56');
    expect(html).toContain('R$ 1.500,00');
    expect(html).toContain('R$ 265,44');
    expect(html).toContain('40 lançamentos');
  });

  it('marca "a confirmar" só nos campos não confirmados', () => {
    const html = render(previa());
    expect(html).toMatch(/data-campo="cTribNac"[\s\S]*?a confirmar[\s\S]*?<\/tr>/);
    expect(html).not.toMatch(/data-campo="vServ"(?:(?!<\/tr>)[\s\S])*a confirmar/);
    expect(html).toContain('1 campo(s) a confirmar');
  });

  it('XML aparece escapado, com copiar e baixar; sem assinatura diz que NÃO está assinado', () => {
    const html = render(previa());
    expect(html).toContain('&lt;vServ&gt;1234.56&lt;/vServ&gt;');
    expect(html).toContain('Copiar XML');
    expect(html).toContain('Baixar XML');
    expect(html).toContain('XML da DPS (NÃO assinado)');
    expect(html).toContain('não assinada');
    expect(html).toContain('Nenhum certificado configurado');
  });

  it('não tem nenhum controle de emitir/enviar/cancelar', () => {
    const html = render(previa()).toLowerCase();
    const botoes = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(botoes).toHaveLength(2);
    for (const botao of botoes) expect(botao).toMatch(/copiar xml|baixar xml/);
    expect(html).not.toMatch(/emitir|transmitir/);
  });

  it('assinada: mostra CNPJ e validade do certificado', () => {
    const base = previa();
    if (base.dps.status !== 'gerada') throw new Error('fixture');
    const html = render(
      previa({
        avisos: [],
        dps: {
          ...base.dps,
          assinatura: {
            status: 'assinada',
            certificadoCnpj: '11222333000181',
            certificadoConfereComPrestador: true,
            certificadoValidoAte: '2027-01-01T03:00:00.000Z',
          },
        },
      }),
    );
    expect(html).toContain('XML da DPS (assinado)');
    expect(html).toContain('do CNPJ 11222333000181');
  });

  it('sem valor: explica que não há DPS e não mostra XML', () => {
    const html = render(
      previa({
        valor: { ...previa().valor, resultadoDeTaxasCents: -100 },
        avisos: ['resultado_nao_positivo'],
        dps: { status: 'sem_valor' },
      }),
    );
    expect(html).toContain('Sem DPS: o resultado de taxas do mês não é positivo');
    expect(html).toContain('-R$ 1,00');
    expect(html).not.toContain('data-testid="nf-xml"');
  });

  it('config incompleta: lista as variáveis que faltam', () => {
    const html = render(
      previa({
        avisos: ['config_com_problemas'],
        configuracao: { problemas: [{ variavel: 'NFSE_PRESTADOR_CNPJ', motivo: 'ausente' }] },
        dps: { status: 'config_incompleta', faltando: ['NFSE_PRESTADOR_CNPJ'] },
      }),
    );
    expect(html).toContain('Sem DPS: faltam dados do prestador.');
    expect(html).toContain('<code class="font-mono">NFSE_PRESTADOR_CNPJ</code>');
  });

  it('mês em andamento ganha aviso', () => {
    const html = render(previa({ situacao: 'em_andamento', avisos: ['mes_em_andamento'] }));
    expect(html).toContain('data-aviso="mes_em_andamento"');
    expect(html).toContain('O mês ainda não terminou');
  });
});

describe('SeletorDeMes e aba', () => {
  it('input de mês rotulado com máximo no mês corrente de SP', () => {
    const html = renderToStaticMarkup(
      React.createElement(SeletorDeMes, {
        mes: '2026-09',
        onAplicar: () => undefined,
        now: () => new Date('2026-10-05T17:30:00Z'),
      }),
    );
    expect(html).toMatch(/<label for="[^"]+-mes"[^>]*>Mês de competência<\/label>/);
    expect(html).toContain('type="month"');
    expect(html).toContain('value="2026-09"');
    expect(html).toContain('max="2026-10"');
  });

  it('aba Nota fiscal na navegação de Pagamentos', () => {
    const html = renderToStaticMarkup(
      React.createElement(PagamentosTabs, { active: 'nota-fiscal' }),
    );
    expect(html).toMatch(
      /<a href="\/admin\/pagamentos\/nota-fiscal" aria-current="page"[^>]*>Nota fiscal \(prévia\)<\/a>/,
    );
    expect(html).toMatch(/<a href="\/admin\/pagamentos\/receita"(?![^>]*aria-current)/);
  });
});

describe('notaFiscalMes', () => {
  const now = new Date('2026-10-05T17:30:00Z');

  it('default é o mês anterior em SP (inclusive na virada do ano)', () => {
    expect(mesPadrao(now)).toBe('2026-09');
    expect(mesAnterior('2027-01')).toBe('2026-12');
    expect(mesPadrao(new Date('2027-01-01T02:00:00Z'))).toBe('2026-11');
  });

  it('?mes= válido e não futuro é respeitado; o resto cai no default', () => {
    expect(mesFromSearch('?mes=2026-03', now)).toBe('2026-03');
    expect(mesFromSearch('?mes=2026-10', now)).toBe('2026-10');
    expect(mesFromSearch('?mes=2026-11', now)).toBe('2026-09');
    expect(mesFromSearch('?mes=2026-13', now)).toBe('2026-09');
    expect(mesFromSearch('', now)).toBe('2026-09');
  });
});
