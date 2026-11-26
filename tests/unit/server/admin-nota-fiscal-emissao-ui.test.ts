import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ConfirmacaoEmissao,
  type Emissao,
  FormularioCancelamento,
  ListaEmissoes,
  type PlanoEmissao,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/nota-fiscal/NotaFiscalEmissao.js';

/**
 * aperture-wp6j6 — o que a tela de emissão DIZ antes do clique: ambiente,
 * série, quantidade, total, tomadores e campos fiscais; bloqueios desligam o
 * botão; o cancelamento exige motivo e redigitar a chave.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const nada = () => undefined;
const texto = (html: string) => html.replace(/\u00a0/g, ' ').replace(/&nbsp;/g, ' ');
const render = (el: unknown) => texto(renderToStaticMarkup(el));

function plano(overrides: Partial<PlanoEmissao> = {}): PlanoEmissao {
  return {
    mes: '2026-10',
    rotulo: 'outubro/2026',
    ambiente: '2',
    serie: '00001',
    notas: [
      {
        tomadorCpf: '52998224725',
        tomadorNome: 'Ana Titular',
        valorCents: 1234,
        campanhas: ['c1'],
      },
      {
        tomadorCpf: '11144477735',
        tomadorNome: 'Bruno Titular',
        valorCents: 500,
        campanhas: ['c2'],
      },
    ],
    puladas: [],
    fixada: false,
    divergencias: [],
    impressao: 'a'.repeat(64),
    quantidade: 2,
    totalCents: 1734,
    bloqueios: [],
    avisos: [],
    camposFiscais: [
      {
        grupo: 'Serviço',
        tag: 'cTribNac',
        rotulo: 'Código de tributação nacional',
        valor: '100202',
        origem: 'default',
        aConfirmar: false,
        nota: null,
      },
      {
        grupo: 'Valores',
        tag: 'totTrib',
        rotulo: 'Total aproximado de tributos',
        valor: 'pTotTrib=11.33/0.00/3.00',
        origem: 'default',
        aConfirmar: false,
        nota: null,
      },
    ],
    ...overrides,
  };
}

function emissao(overrides: Partial<Emissao> = {}): Emissao {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ambiente: '2',
    competencia: '2026-10',
    tomadorCpf: '52998224725',
    tomadorNome: 'Ana Titular',
    valorCents: 1234,
    serie: '00001',
    nDps: '7',
    idDps: `DPS31062002${'1'.repeat(13)}00001${'7'.padStart(15, '0')}`,
    status: 'autorizada',
    tentativas: 1,
    chaveAcesso: '3'.repeat(50),
    numeroNfse: '42',
    erros: null,
    cancelamentoStatus: null,
    cancelamentoMotivo: null,
    cancelamentoTexto: null,
    criadaEm: '2026-11-01T12:00:00.000Z',
    enviadaEm: '2026-11-01T12:00:00.000Z',
    autorizadaEm: '2026-11-01T12:00:01.000Z',
    canceladaEm: null,
    temDpsXml: true,
    temNfseXml: true,
    ...overrides,
  };
}

const confirmacao = (p: PlanoEmissao) =>
  render(
    React.createElement(ConfirmacaoEmissao, {
      plano: p,
      enviando: false,
      onConfirmar: nada,
      onVoltar: nada,
    }),
  );

describe('ConfirmacaoEmissao', () => {
  it('mostra ambiente, série, quantidade, total, tomadores e campos fiscais', () => {
    const html = confirmacao(plano());
    expect(html).toContain('Confirmar emissão das NFS-e de outubro/2026');
    expect(html).toContain('Homologação (produção restrita, sem valor fiscal)');
    expect(html).toContain('00001');
    expect(html).toMatch(/data-testid="nf-quantidade"[^>]*>2</);
    expect(html).toContain('R$ 17,34');
    expect(html).toContain('Ana Titular');
    expect(html).toContain('52998224725');
    expect(html).toContain('R$ 12,34');
    expect(html).toContain('Bruno Titular');
    expect(html).toContain('data-campo-fiscal="cTribNac"');
    expect(html).toContain('pTotTrib=11.33/0.00/3.00');
  });

  it('o botão de confirmar começa desligado (exige marcar "conferi")', () => {
    const html = confirmacao(plano());
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirmar emissão de 2 nota\(s\)<\/button>/);
  });

  it('produção é destacada e avisa do valor fiscal', () => {
    const html = confirmacao(plano({ ambiente: '1' }));
    expect(html).toContain('PRODUÇÃO (nota com valor fiscal)');
    expect(html).toContain('estas notas terão valor fiscal');
  });

  it('bloqueios aparecem explicados e o checkbox fica desligado', () => {
    const html = confirmacao(
      plano({ bloqueios: ['pendencias_de_tomador', 'producao_nao_liberada'] }),
    );
    expect(html).toContain('A emissão está bloqueada');
    expect(html).toContain('nenhuma nota do mês é emitida');
    expect(html).toContain('NFSE_EMISSAO_PRODUCAO');
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
  });
});

describe('ConfirmacaoEmissao — competência já fixada', () => {
  it('divergência: explica o bloqueio e lista as diferenças', () => {
    const html = confirmacao(
      plano({
        fixada: true,
        bloqueios: ['competencia_divergente'],
        divergencias: ['Recalculada e não fixada: CPF 39053344705, 1234 centavos, campanhas c1'],
      }),
    );
    expect(html).toContain('Este mês já teve emissão');
    expect(html).toContain('Nada novo é emitido');
    expect(html).toContain('CPF 39053344705');
  });
});

describe('ConfirmacaoEmissao — pendências puladas', () => {
  it('lista o que fica de fora e diz que pode ser emitido depois', () => {
    const html = confirmacao(
      plano({
        puladas: [{ referencia: 'camp-1', motivo: 'cpf_ausente_ou_invalido', valorCents: 300 }],
      }),
    );
    expect(html).toContain('Ficam de fora desta emissão (1)');
    expect(html).toContain('CPF ausente ou inválido — R$ 3,00');
    expect(html).toContain('camp-1');
    expect(html).toContain('Podem ser emitidas depois, neste mesmo mês');
  });
});

describe('ListaEmissoes', () => {
  const lista = (emissoes: Emissao[]) =>
    render(
      React.createElement(ListaEmissoes, {
        emissoes,
        ocupado: false,
        onConsultar: nada,
        onBaixarXml: nada,
        onBaixarDanfse: nada,
        onCancelar: nada,
      }),
    );

  it('vazia diz que nada foi emitido', () => {
    expect(lista([])).toContain('Nenhuma NFS-e emitida para este mês neste ambiente.');
  });

  it('autorizada: número, chave, XMLs, DANFSe e cancelar', () => {
    const html = lista([emissao()]);
    expect(html).toContain('nº 42');
    expect(html).toContain('3'.repeat(50));
    for (const b of ['Consultar', 'XML DPS', 'XML NFS-e', 'DANFSe', 'Cancelar NFS-e'])
      expect(html).toContain(`>${b}</button>`);
  });

  it('rejeitada mostra os erros do Sistema Nacional e não oferece cancelar', () => {
    const html = lista([
      emissao({
        status: 'rejeitada',
        chaveAcesso: null,
        numeroNfse: null,
        temNfseXml: false,
        erros: [{ codigo: 'E0312', descricao: 'cTribNac nao habilitado', complemento: null }],
      }),
    ]);
    expect(html).toContain('E0312');
    expect(html).toContain('cTribNac nao habilitado');
    expect(html).not.toContain('Cancelar NFS-e');
    expect(html).not.toContain('DANFSe');
  });

  it('incerta orienta consultar antes de reenviar', () => {
    expect(lista([emissao({ status: 'incerta', chaveAcesso: null, numeroNfse: null })])).toContain(
      'consulte antes de reenviar',
    );
  });
});

describe('FormularioCancelamento', () => {
  it('pede motivo oficial, justificativa e a chave redigitada; começa desligado', () => {
    const html = render(
      React.createElement(FormularioCancelamento, {
        emissao: emissao(),
        enviando: false,
        onConfirmar: nada,
        onVoltar: nada,
      }),
    );
    expect(html).toContain('Cancelar a NFS-e nº 42 de Ana Titular');
    expect(html).toContain('1 — Erro na emissão');
    expect(html).toContain('2 — Serviço não prestado');
    expect(html).toContain('9 — Outros');
    expect(html).toContain('Justificativa (15 a 255 caracteres)');
    expect(html).toContain('digite a chave de acesso');
    expect(html).toMatch(
      /<button type="submit"[^>]*disabled=""[^>]*>Confirmar cancelamento<\/button>/,
    );
  });
});
