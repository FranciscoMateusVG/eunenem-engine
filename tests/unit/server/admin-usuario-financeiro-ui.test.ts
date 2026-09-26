import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  type CampanhaAdministradaRow,
  CampanhasAdministradasTable,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/CampanhasAdministradasTable.js';
import {
  type LancamentoAdminRow,
  LancamentosAdminTable,
  type LancamentosAdminTableProps,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/LancamentosAdminTable.js';
import {
  ResumoFinanceiroCard,
  type TotaisResumo,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/ResumoFinanceiroCard.js';
import {
  type TransferenciaAdminRow,
  TransferenciasAdminTable,
  type TransferenciasAdminTableProps,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/TransferenciasAdminTable.js';

/**
 * aperture-5jk8y — SSR (renderToStaticMarkup) dos componentes puros do detalhe
 * financeiro. Cada rótulo/estado/máscara/vazio é asserido pelo texto; o
 * número completo do celular nunca chega a estes componentes (o servidor
 * mascara), e aqui provamos que o markup não o contém.
 */

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const ZERO: TotaisResumo = {
  recebidoConfirmadoCents: 0,
  disponivelCents: 0,
  aguardandoLiberacaoCents: 0,
  aguardandoTransferenciaCents: 0,
  transferenciaFalhouCents: 0,
  emTransferenciaCents: 0,
  enviadoAoBancoCents: 0,
  transferidoCents: 0,
  resgatadoConcluidoCents: 0,
  estornoEmAndamentoCents: 0,
  inconsistenteCents: 0,
  pendenteConferenciaCents: 0,
  estornadoCents: 0,
  estornadoCount: 0,
  anomaliaCents: 0,
  anomaliaCount: 0,
  lancamentosCount: 0,
};

const TOTAIS: TotaisResumo = {
  recebidoConfirmadoCents: 340000,
  disponivelCents: 100000,
  aguardandoLiberacaoCents: 50000,
  aguardandoTransferenciaCents: 80000,
  transferenciaFalhouCents: 5000,
  emTransferenciaCents: 85000,
  enviadoAoBancoCents: 0,
  transferidoCents: 70000,
  resgatadoConcluidoCents: 70000,
  estornoEmAndamentoCents: 30000,
  inconsistenteCents: 5000,
  pendenteConferenciaCents: 35000,
  estornadoCents: 50000,
  estornadoCount: 1,
  anomaliaCents: 60000,
  anomaliaCount: 2,
  lancamentosCount: 11,
};

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('ResumoFinanceiroCard', () => {
  it('mostra os buckets com rótulos honestos e a fórmula; sem diferença quando 0', () => {
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(ResumoFinanceiroCard, {
          totais: TOTAIS,
          ledgerAprovadoSemCancelCents: 340000,
          diferencaNaoConciliadaCents: 0,
          campanhasTotal: 2,
        }),
      ),
    );
    expect(html).toContain('Recebido (confirmado)');
    expect(html).toContain('R$ 3.400,00');
    expect(html).toContain('Resgatado (concluído)');
    expect(html).toContain('R$ 700,00');
    expect(html).toContain('Disponível para resgate');
    expect(html).toContain('Aguardando liberação');
    expect(html).toContain('Em transferência');
    expect(html).toContain('falhou R$ 50,00');
    expect(html).toContain('Pendente de conferência');
    expect(html).toContain('estorno em andamento R$ 300,00');
    expect(html).toContain('Estornado (fora do recebido)');
    expect(html).toContain('Anomalias (fora do recebido)');
    expect(html).toContain('2 linhas sem pagamento aprovado');
    expect(html).toContain('ainda não foi estornado');
    expect(html).toContain('2 campanhas administradas');
    expect(html).toContain('11 lançamentos');
    expect(html).toContain('recebido = disponível + aguardando liberação');
    expect(html).toContain('não disponíveis nesta versão');
    expect(html).not.toContain('Diferença não conciliada');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('alerta a diferença não conciliada quando ≠ 0, sem ajustar valores', () => {
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(ResumoFinanceiroCard, {
          totais: TOTAIS,
          ledgerAprovadoSemCancelCents: 341234,
          diferencaNaoConciliadaCents: -1234,
          campanhasTotal: 2,
        }),
      ),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Diferença não conciliada: -R$ 12,34');
    expect(html).toContain('R$ 3.400,00');
    expect(html).toContain('R$ 3.412,34');
    expect(html).toContain('não ajustado');
  });

  it('vazio: zeros honestos, sem tile de anomalias, sem ressalva de estorno', () => {
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(ResumoFinanceiroCard, {
          totais: ZERO,
          ledgerAprovadoSemCancelCents: 0,
          diferencaNaoConciliadaCents: 0,
          campanhasTotal: 0,
        }),
      ),
    );
    expect(html).toContain('Nenhum lançamento nas campanhas administradas');
    expect(html).toContain('0 campanhas administradas');
    expect(html).toContain('R$ 0,00');
    expect(html).not.toContain('Anomalias');
    expect(html).not.toContain('ainda não foi estornado');
  });
});

describe('CampanhasAdministradasTable', () => {
  const OWNER = '12000000-0000-4000-8000-0000000000a1';
  const rows: CampanhaAdministradaRow[] = [
    {
      idCampanha: '10000000-0000-4000-8000-0000000000c1',
      titulo: 'Chá A',
      administradores: [
        { idConta: OWNER, nomeExibicao: 'Owner', email: 'o@x.test' },
        {
          idConta: '12000000-0000-4000-8000-0000000000a2',
          nomeExibicao: 'Coadmin',
          email: 'c@x.test',
        },
        { idConta: '12000000-0000-4000-8000-0000000000a3', nomeExibicao: null, email: null },
      ],
      celularTitularMascarado: '(**) *****-4321',
      totais: TOTAIS,
    },
    {
      idCampanha: '10000000-0000-4000-8000-0000000000c2',
      titulo: 'Chá B',
      administradores: [{ idConta: OWNER, nomeExibicao: 'Owner', email: 'o@x.test' }],
      celularTitularMascarado: null,
      totais: ZERO,
    },
  ];

  it('lista campanhas, coadmins explícitos e celular mascarado', () => {
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(CampanhasAdministradasTable, {
          idConta: OWNER,
          campanhas: rows,
          campanhasTotal: 2,
          truncated: false,
        }),
      ),
    );
    expect(html).toContain('campanhas administradas por esta conta (2)');
    expect(html).toContain('href="/admin/campanha/10000000-0000-4000-8000-0000000000c1"');
    expect(html).toContain('Coadmin, 12000000…');
    expect(html).toContain('somente esta conta');
    expect(html).toContain('(**) *****-4321');
    expect(html).toContain('não informado');
    expect(html).toContain('celular do titular');
    expect(html).not.toContain('11987654321');
    expect(html).not.toContain('mostrando');
  });

  it('declara truncamento quando >100', () => {
    const html = renderToStaticMarkup(
      React.createElement(CampanhasAdministradasTable, {
        idConta: OWNER,
        campanhas: rows,
        campanhasTotal: 101,
        truncated: true,
      }),
    );
    expect(html).toContain('mostrando 2 de 101');
    expect(html).toContain('totais acima cobrem todas');
  });

  it('vazio honesto', () => {
    const html = renderToStaticMarkup(
      React.createElement(CampanhasAdministradasTable, {
        idConta: OWNER,
        campanhas: [],
        campanhasTotal: 0,
        truncated: false,
      }),
    );
    expect(html).toContain('Sem campanhas administradas.');
    expect(html).not.toContain('<table');
  });
});

function lanc(overrides: Partial<LancamentoAdminRow>): LancamentoAdminRow {
  return {
    idLancamento: '40000000-0000-4000-8000-000000000001',
    criadoEm: '2026-09-01T12:00:00.000Z',
    pagamentoCriadoEm: '2026-09-01T12:00:00.000Z',
    idCampanha: '10000000-0000-4000-8000-0000000000c1',
    campanhaTitulo: 'Chá A',
    idContribuicao: '30000000-0000-4000-8000-000000000001',
    contribuicaoNome: 'Berço',
    idPagamento: '20000000-0000-4000-8000-000000000001',
    metodo: 'pix',
    amountCents: 10000,
    bucket: 'disponivel',
    motivo: null,
    elegivelRecebido: true,
    liberacaoPrevistaEm: null,
    idRepasse: null,
    repasseStatus: null,
    transferidoEm: null,
    canceladoEm: null,
    ...overrides,
  };
}

function lancProps(overrides: Partial<LancamentosAdminTableProps>): LancamentosAdminTableProps {
  return {
    rows: [],
    totalCount: 0,
    isLoading: false,
    isFetching: false,
    errorMessage: null,
    estado: null,
    onEstadoChange: () => {},
    idCampanha: null,
    onCampanhaChange: () => {},
    campanhas: [{ idCampanha: '10000000-0000-4000-8000-0000000000c1', titulo: 'Chá A' }],
    hasNext: false,
    onNext: () => {},
    hasPrev: false,
    onPrev: () => {},
    pageIndex: 0,
    filterIdPrefix: 'f',
    ...overrides,
  };
}

describe('LancamentosAdminTable', () => {
  it('renderiza cada bucket com rótulo e sub-linha honesta; sem telefone', () => {
    const rows: LancamentoAdminRow[] = [
      lanc({ idLancamento: 'a', bucket: 'disponivel' }),
      lanc({
        idLancamento: 'b',
        bucket: 'aguardando_liberacao',
        liberacaoPrevistaEm: '2026-10-02T12:00:00.000Z',
      }),
      lanc({ idLancamento: 'c', bucket: 'aguardando_liberacao', liberacaoPrevistaEm: null }),
      lanc({
        idLancamento: 'd',
        bucket: 'aguardando_transferencia',
        idRepasse: '50000000-0000-4000-8000-000000000001',
        repasseStatus: 'solicitado',
      }),
      lanc({
        idLancamento: 'e',
        bucket: 'transferencia_falhou',
        idRepasse: '50000000-0000-4000-8000-000000000002',
        repasseStatus: 'falhou',
      }),
      lanc({ idLancamento: 'f', bucket: 'enviado_ao_banco' }),
      lanc({ idLancamento: 'g', bucket: 'transferido', transferidoEm: '2026-09-22T12:00:00.000Z' }),
      lanc({ idLancamento: 'h', bucket: 'estorno_em_andamento' }),
      lanc({ idLancamento: 'i', bucket: 'inconsistente', motivo: 'repasse_pago_sem_transferido' }),
      lanc({
        idLancamento: 'j',
        bucket: 'estornado',
        elegivelRecebido: false,
        canceladoEm: '2026-09-10T12:00:00.000Z',
      }),
      lanc({
        idLancamento: 'k',
        bucket: 'anomalia',
        motivo: 'pagamento_nao_aprovado',
        elegivelRecebido: false,
        contribuicaoNome: null,
        metodo: null,
      }),
    ];
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(LancamentosAdminTable, lancProps({ rows, totalCount: 11 })),
      ),
    );
    expect(html).toContain('lançamentos (11)');
    for (const label of [
      'Disponível',
      'Aguardando liberação',
      'Aguardando transferência',
      'Transferência falhou',
      'Enviado ao banco',
      'Transferido',
      'Estorno em andamento',
      'Inconsistente',
      'Estornado',
      'Anomalia',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('previsto para 02/10/2026');
    expect(html).toContain('data de liberação desconhecida');
    expect(html).toContain('valor ainda não estornado');
    expect(html).toContain('repasse pago sem carimbo de transferência');
    expect(html).toContain('pagamento não aprovado');
    expect(html).toContain('(contribuição removida)');
    expect(html).toContain('href="/admin/repasses/50000000-0000-4000-8000-000000000001"');
    expect(html).toContain('50000000… · Solicitado');
    expect(html).toContain('href="/admin/pagamento/20000000-0000-4000-8000-000000000001"');
    expect(html).toContain('PIX · 20000000…');
    expect(html).toContain('line-through');
    expect(html).toContain('<select id="f-estado"');
    expect(html).toContain('<select id="f-campanha"');
    expect(html).toContain('<label for="f-estado"');
    expect(html).not.toContain('celular');
    expect(html).not.toContain('<button'); // sem paginação quando não há próxima/anterior; sem ações
  });

  it('loading, erro e vazio (com e sem filtro) são explícitos', () => {
    const loading = renderToStaticMarkup(
      React.createElement(LancamentosAdminTable, lancProps({ isLoading: true })),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Nenhum lançamento');

    const erro = renderToStaticMarkup(
      React.createElement(LancamentosAdminTable, lancProps({ errorMessage: 'boom' })),
    );
    expect(erro).toContain('erro ao carregar');
    expect(erro).toContain('boom');

    const vazio = renderToStaticMarkup(React.createElement(LancamentosAdminTable, lancProps({})));
    expect(vazio).toContain('Nenhum lançamento.');

    const vazioFiltro = renderToStaticMarkup(
      React.createElement(LancamentosAdminTable, lancProps({ estado: 'estornado' })),
    );
    expect(vazioFiltro).toContain('Nenhum lançamento neste filtro.');
  });

  it('paginação: botões nativos com estado desabilitado correto', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        LancamentosAdminTable,
        lancProps({
          rows: [lanc({})],
          totalCount: 30,
          hasNext: true,
          hasPrev: false,
          pageIndex: 0,
        }),
      ),
    );
    expect(html).toContain('página 1');
    // Atributo `disabled=""` (não a classe utilitária `disabled:`).
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>← anterior/);
    expect(html).toMatch(/<button type="button"(?![^>]*\sdisabled=")[^>]*>próxima →/);
  });
});

describe('TransferenciasAdminTable', () => {
  function repProps(
    overrides: Partial<TransferenciasAdminTableProps>,
  ): TransferenciasAdminTableProps {
    return {
      rows: [],
      totalCount: 0,
      isLoading: false,
      isFetching: false,
      errorMessage: null,
      hasNext: false,
      onNext: () => {},
      hasPrev: false,
      onPrev: () => {},
      pageIndex: 0,
      ...overrides,
    };
  }
  const row: TransferenciaAdminRow = {
    idRepasse: '50000000-0000-4000-8000-000000000001',
    idCampanha: '10000000-0000-4000-8000-0000000000c2',
    campanhaTitulo: 'Chá B',
    recebedorNome: 'Titular B',
    amountCents: 80000,
    numLancamentos: 3,
    status: 'solicitado',
    solicitadoEm: '2026-09-20T12:00:00.000Z',
    enviadoAoBancoEm: null,
    bankTransferRef: null,
    transferReferencia: null,
    estadoExtrato: 'aguardando_aprovacao',
    concluidoEm: null,
    needsManualResolution: false,
  };

  it('renderiza estadoExtrato da projeção compartilhada, sem destino/telefone', () => {
    const html = nbsp(
      renderToStaticMarkup(
        React.createElement(
          TransferenciasAdminTable,
          repProps({
            rows: [
              row,
              {
                ...row,
                idRepasse: '50000000-0000-4000-8000-000000000002',
                status: 'pago',
                estadoExtrato: 'concluido',
                concluidoEm: '2026-09-22T12:00:00.000Z',
                transferReferencia: 'REF-123',
              },
              {
                ...row,
                idRepasse: '50000000-0000-4000-8000-000000000003',
                status: 'verificando',
                estadoExtrato: 'inconsistente',
                needsManualResolution: true,
              },
            ],
            totalCount: 3,
          }),
        ),
      ),
    );
    expect(html).toContain('repasses (3)');
    expect(html).toContain('Aguardando aprovação');
    expect(html).toContain('Concluído');
    expect(html).toContain('Pendente de conferência');
    expect(html).toContain('resolução manual');
    expect(html).toContain('status Solicitado');
    expect(html).toContain('R$ 800,00');
    expect(html).toContain('Titular B');
    expect(html).toContain('REF-123');
    expect(html).toContain('href="/admin/repasses/50000000-0000-4000-8000-000000000001"');
    expect(html).not.toContain('celular');
    expect(html).not.toContain('chave');
    expect(html).not.toContain('Aprovar');
  });

  it('vazio, loading e erro honestos', () => {
    expect(
      renderToStaticMarkup(React.createElement(TransferenciasAdminTable, repProps({}))),
    ).toContain('Nenhuma transferência.');
    expect(
      renderToStaticMarkup(
        React.createElement(TransferenciasAdminTable, repProps({ isLoading: true })),
      ),
    ).toContain('aria-busy="true"');
    expect(
      renderToStaticMarkup(
        React.createElement(TransferenciasAdminTable, repProps({ errorMessage: 'falhou' })),
      ),
    ).toContain('erro ao carregar');
  });
});
