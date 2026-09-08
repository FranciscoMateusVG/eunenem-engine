import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  RecipientMethodChoice,
  recipientModeFromSaved,
  toDadosRecebedor,
  validateRecipientForm,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/BancariosBody.js';
import type {
  BancariosForm,
  BancariosMode,
} from '../../../apps/eunenem-server/pages/lib/mocks/bancarios.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const COMPLETE_FORM: BancariosForm = {
  bankCode: '077',
  agencia: '1234',
  agenciaDV: '',
  conta: '98765',
  contaDV: '4',
  tipoConta: 'cc',
  pixKey: '529.982.247-25',
  nome: 'Maria da Silva',
  telefone: '(31) 99999-9999',
  cpfTitular: '',
};

const SAVED_PIX: DadosRecebedor = {
  metodo: 'pix',
  nomeTitular: 'Maria da Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'cpf',
  chavePix: '52998224725',
};

const SAVED_ACCOUNT: DadosRecebedor = {
  metodo: 'conta',
  nomeTitular: 'Maria da Silva',
  cpfTitular: '52998224725',
  celularTitular: '31999999999',
  codigoBanco: '077',
  agencia: '1234',
  agenciaDigito: null,
  conta: '98765',
  contaDigito: '4',
  tipoConta: 'cc',
};

function methodChoiceHtml(modo: BancariosMode): string {
  return renderToStaticMarkup(
    createElement(RecipientMethodChoice, { modo, onSelect: () => undefined }),
  );
}

function findButton(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (element.type === 'button') return element.props;
  return findButton(element.props?.children);
}

describe('PIX-first recipient setup', () => {
  it('defaults unconfigured and saved PIX recipients to PIX, while preserving saved bank accounts', () => {
    expect(recipientModeFromSaved(undefined)).toBe('pix');
    expect(recipientModeFromSaved(null)).toBe('pix');
    expect(recipientModeFromSaved(SAVED_PIX)).toBe('pix');
    expect(recipientModeFromSaved(SAVED_ACCOUNT)).toBe('conta');
  });

  it('renders bank account as a secondary action instead of equal tabs', () => {
    const pixHtml = methodChoiceHtml('pix');
    expect(pixHtml).toContain('Não quer usar Pix?');
    expect(pixHtml).toContain('Usar conta bancária');
    expect(pixHtml).not.toContain('role="tab"');
    expect(pixHtml).not.toContain('tablist');

    const accountHtml = methodChoiceHtml('conta');
    expect(accountHtml).toContain('Voltar para Pix');
    expect(accountHtml).not.toContain('Não quer usar Pix?');
  });

  it.each([
    ['pix', 'conta'],
    ['conta', 'pix'],
  ] as const)('switches from %s to %s without submitting or receiving form data', (modo, target) => {
    const onSelect = vi.fn();
    const tree = RecipientMethodChoice({ modo, onSelect });
    const button = findButton(tree);

    expect(button?.type).toBe('button');
    expect(button?.onClick).toBeTypeOf('function');
    (button?.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it('requires and submits only the selected method fields', () => {
    const pixOnly: BancariosForm = {
      ...COMPLETE_FORM,
      bankCode: '',
      agencia: '',
      conta: '',
      contaDV: '',
      telefone: '',
    };
    expect(validateRecipientForm('pix', pixOnly, 'cpf', '529.982.247-25')).toEqual([]);
    expect(validateRecipientForm('conta', pixOnly, 'cpf', '529.982.247-25')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: 'bankCode' }),
        expect.objectContaining({ k: 'agencia' }),
        expect.objectContaining({ k: 'conta' }),
        expect.objectContaining({ k: 'contaDV' }),
        expect.objectContaining({ k: 'telefone' }),
      ]),
    );

    const pixPayload = toDadosRecebedor('pix', COMPLETE_FORM, 'cpf', '529.982.247-25');
    expect(pixPayload).toEqual({
      metodo: 'pix',
      nomeTitular: 'Maria da Silva',
      cpfTitular: '52998224725',
      tipoChavePix: 'cpf',
      chavePix: '52998224725',
    });
    expect(pixPayload).not.toHaveProperty('codigoBanco');

    const accountPayload = toDadosRecebedor(
      'conta',
      { ...COMPLETE_FORM, pixKey: '' },
      'cpf',
      '529.982.247-25',
    );
    expect(accountPayload).toMatchObject({
      metodo: 'conta',
      codigoBanco: '077',
      agencia: '1234',
      conta: '98765',
      contaDigito: '4',
      celularTitular: '31999999999',
    });
    expect(accountPayload).not.toHaveProperty('chavePix');
  });

  it('keeps the method action keyboard-sized and responsive at the requested widths', () => {
    const source = readFileSync(
      'apps/eunenem-server/pages/components/eunenem/painel/BancariosBody.tsx',
      'utf8',
    );
    expect(source).toMatch(/\.bnc-method-choice button\{[^}]*min-height:44px/);
    expect(source).toMatch(/button:focus-visible\{outline:3px solid var\(--lilac\)/);
    expect(source).toMatch(/@media \(max-width:439px\)\{\.bnc-method-choice/);
    expect(source).not.toContain('bnc-mode-toggle');
    expect(source).not.toContain('bnc-slider');
  });
});
