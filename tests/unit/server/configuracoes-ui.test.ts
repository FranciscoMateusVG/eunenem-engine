import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ConfiguracoesView,
  type ConfiguracoesViewProps,
  DesativarContaDialog,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ConfiguracoesBody.js';

/**
 * aperture-851nu — tela de Configurações ligada ao backend: toggles reais
 * para "Presentes recebidos" e "Exibir recados publicamente", e o diálogo de
 * desativação da conta (soft delete) com motivo de bloqueio visível.
 */

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const noop = () => undefined;

function props(over: Partial<ConfiguracoesViewProps> = {}): ConfiguracoesViewProps {
  return {
    slug: 'helena',
    idCampanha: '10000000-0000-4000-8000-000000000001',
    pode: () => true,
    config: { exibirRecados: true, emails: { presentes: true } },
    carregando: false,
    erroAoCarregar: false,
    onRecarregar: noop,
    salvando: {},
    onEmail: noop,
    onExibirRecados: noop,
    desativacao: { pendente: false, erro: null, concluida: false, onConfirmar: noop },
    ...over,
  };
}

const render = (p: ConfiguracoesViewProps) =>
  renderToStaticMarkup(React.createElement(ConfiguracoesView, p));

/** The `<label>` block of a switch, so we can read its input attributes and helper text. */
function toggle(html: string, label: string): { input: string; bloco: string } {
  const bloco = html
    .split('<label class="config-toggle"')
    .find((part) => part.includes(`aria-label="${label}"`));
  if (!bloco) throw new Error(`switch ${label} não encontrado`);
  const input = bloco.match(/<input[^>]*>/)?.[0] ?? '';
  return { input, bloco };
}

describe('ConfiguracoesView', () => {
  it('liga os toggles de Presentes recebidos e Exibir recados ao estado do servidor', () => {
    const html = render(props({ config: { exibirRecados: false, emails: { presentes: true } } }));
    const presentes = toggle(html, 'Presentes recebidos');
    expect(presentes.input).not.toContain('disabled');
    expect(presentes.input).toContain('checked');
    expect(presentes.bloco).not.toContain('Indisponível');

    const recados = toggle(html, 'Exibir recados publicamente');
    expect(recados.input).not.toContain('disabled');
    expect(recados.input).not.toContain('checked');
    expect(recados.bloco).not.toContain('Indisponível');
    expect(html).not.toContain('Controle de privacidade indisponível');
  });

  it('sem mensagens:gerenciar o toggle de recados fica bloqueado e explica o motivo', () => {
    const html = render(props({ pode: (acao) => acao !== 'mensagens:gerenciar' }));
    expect(toggle(html, 'Exibir recados publicamente').input).toContain('disabled');
    expect(html).toContain('Somente quem gerencia as mensagens pode alterar');
    expect(toggle(html, 'Presentes recebidos').input).not.toContain('disabled');
  });

  it('enquanto carrega ou salvando, os toggles ficam desabilitados', () => {
    const carregando = render(props({ config: undefined, carregando: true }));
    expect(toggle(carregando, 'Presentes recebidos').input).toContain('disabled');
    expect(toggle(carregando, 'Exibir recados publicamente').input).toContain('disabled');

    const salvando = render(props({ salvando: { presentes: true } }));
    expect(toggle(salvando, 'Presentes recebidos').input).toContain('disabled');
  });

  it('falha ao carregar mostra erro com opção de tentar de novo', () => {
    const html = render(props({ config: undefined, erroAoCarregar: true }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Tentar de novo');
  });
});

describe('DesativarContaDialog', () => {
  const dialog = (over: Partial<Parameters<typeof DesativarContaDialog>[0]> = {}) =>
    renderToStaticMarkup(
      React.createElement(DesativarContaDialog, {
        pendente: false,
        erro: null,
        concluida: false,
        onConfirmar: noop,
        onFechar: noop,
        ...over,
      }),
    );

  it('explica a desativação sem apagar dados e mantém o atendimento', () => {
    const html = dialog();
    expect(html).toContain('desativada');
    expect(html).toContain('Nada é apagado');
    expect(html).toContain('única pessoa titular');
    expect(html).toMatch(/href="https:\/\/wa\.me\//);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Desativar minha conta<\/button>/);
  });

  it('mostra o motivo do bloqueio vindo do servidor', () => {
    const html = dialog({
      erro: 'Você ainda tem saldo a sacar. Resgate o valor antes de desativar a conta.',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Você ainda tem saldo a sacar.');
  });

  it('confirma ao usuário que a conta foi desativada', () => {
    const html = dialog({ concluida: true });
    expect(html).toContain('Sua conta foi desativada');
    expect(html).not.toContain('Desativar minha conta</button>');
  });
});
