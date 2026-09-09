import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  AdminUsersFilterInput,
  AdminUsersFilters,
  adminUsersSearchInput,
} from '../../../apps/eunenem-server/pages/AdminPage.js';
import {
  UserPickerDropdown,
  userPickerKeyboardAction,
  userPickerSearchInput,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/UserPicker.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

function findElement(
  node: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const props = element.props ?? {};
  if (predicate(element.type, props)) return props;
  return findElement(props.children, predicate);
}

describe('admin search controls', () => {
  it('submits independent trimmed email and campaign filters with the contract field names', () => {
    expect(adminUsersSearchInput('  ana@exemplo.com  ', '  lista-francisco  ')).toEqual({
      emailPrefix: 'ana@exemplo.com',
      campaignQuery: 'lista-francisco',
    });
    expect(adminUsersSearchInput('   ', '')).toEqual({
      emailPrefix: undefined,
      campaignQuery: undefined,
    });
    expect(userPickerSearchInput('  Francisco Mateus  ')).toEqual({
      query: 'Francisco Mateus',
    });
  });

  it('presents the user list campaign filter with a bounded accessible input', () => {
    const onChange = vi.fn();
    const tree = AdminUsersFilterInput({
      label: 'Campanha',
      ariaLabel: 'Filtrar usuários por campanha ou link da campanha',
      placeholder: 'Nome, link ou slug da campanha',
      maxLength: 160,
      value: '',
      onChange,
    });
    const input = findElement(tree, (type) => type === 'input');

    expect(input).toMatchObject({
      type: 'search',
      placeholder: 'Nome, link ou slug da campanha',
      'aria-label': 'Filtrar usuários por campanha ou link da campanha',
      maxLength: 160,
    });
    expect(input?.onChange).toBeTypeOf('function');
    (input?.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'lista-francisco' },
    });
    expect(onChange).toHaveBeenCalledWith('lista-francisco');

    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain('PREFIX');
    expect(html).toContain('min-h-11');
    expect(html).toContain('min-w-0');
  });

  it('keeps email and campaign independent and clears both through one explicit action', () => {
    const onEmailPrefixChange = vi.fn();
    const onCampaignQueryChange = vi.fn();
    const onClear = vi.fn();
    const tree = AdminUsersFilters({
      emailPrefix: 'ana@',
      campaignQuery: 'lista-francisco',
      onEmailPrefixChange,
      onCampaignQueryChange,
      onClear,
    });
    const campaign = findElement(
      tree,
      (_type, props) => props.ariaLabel === 'Filtrar usuários por campanha ou link da campanha',
    );
    expect(campaign?.onChange).toBeTypeOf('function');
    (campaign?.onChange as (next: string) => void)('lista-nova');
    expect(onCampaignQueryChange).toHaveBeenCalledWith('lista-nova');
    expect(onEmailPrefixChange).not.toHaveBeenCalled();

    const clear = findElement(
      tree,
      (type, props) => type === 'button' && props.children === 'Limpar filtros',
    );
    (clear?.onClick as () => void)();
    expect(onClear).toHaveBeenCalledOnce();

    const empty = renderToStaticMarkup(
      React.createElement(AdminUsersFilters, {
        emailPrefix: '',
        campaignQuery: '',
        onEmailPrefixChange,
        onCampaignQueryChange,
        onClear,
      }),
    );
    expect(empty).not.toContain('Limpar filtros');
  });

  it('renders honest zero, error and multiple-result states in the quick jump', () => {
    const base = {
      id: 'picker-results',
      activeIndex: -1,
      results: [],
      isFetching: false,
      noResults: false,
      errorMessage: null,
      onHover: () => undefined,
      onSelect: () => undefined,
    };

    const zero = renderToStaticMarkup(
      React.createElement(UserPickerDropdown, { ...base, noResults: true }),
    );
    expect(zero).toContain('Nenhum usuário encontrado.');

    const error = renderToStaticMarkup(
      React.createElement(UserPickerDropdown, {
        ...base,
        errorMessage: 'falha de leitura',
      }),
    );
    expect(error).toContain('Erro: falha de leitura');

    const multiple = renderToStaticMarkup(
      React.createElement(UserPickerDropdown, {
        ...base,
        activeIndex: 1,
        results: [
          { idConta: 'conta-a', email: 'a@example.test', nomeExibicao: 'Ana' },
          { idConta: 'conta-b', email: 'b@example.test', nomeExibicao: 'Bia' },
        ],
      }),
    );
    expect(multiple).toContain('role="option"');
    expect(multiple).toContain('a@example.test');
    expect(multiple).toContain('b@example.test');
    expect(multiple.match(/aria-selected="true"/g)).toHaveLength(1);
  });

  it('selects only the explicitly activated quick-jump result', () => {
    const onSelect = vi.fn();
    const tree = UserPickerDropdown({
      id: 'picker-results',
      activeIndex: 0,
      results: [
        { idConta: 'conta-a', email: 'a@example.test', nomeExibicao: 'Ana' },
        { idConta: 'conta-b', email: 'b@example.test', nomeExibicao: 'Bia' },
      ],
      isFetching: false,
      noResults: false,
      errorMessage: null,
      onHover: () => undefined,
      onSelect,
    });
    const second = findElement(tree, (_type, props) => props.id === 'picker-results-opt-1');

    expect(onSelect).not.toHaveBeenCalled();
    expect(second?.onClick).toBeTypeOf('function');
    (second?.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('conta-b');
  });

  it('preserves Arrow, Enter and Escape keyboard behavior without auto-selecting ambiguity', () => {
    expect(userPickerKeyboardAction('ArrowDown', 2, -1)).toEqual({
      type: 'move',
      index: 0,
    });
    expect(userPickerKeyboardAction('ArrowDown', 2, 1)).toEqual({
      type: 'move',
      index: 0,
    });
    expect(userPickerKeyboardAction('ArrowUp', 2, 0)).toEqual({
      type: 'move',
      index: 1,
    });
    expect(userPickerKeyboardAction('Enter', 2, -1)).toEqual({
      type: 'select',
      index: 0,
    });
    expect(userPickerKeyboardAction('Escape', 2, 1)).toEqual({ type: 'dismiss' });
    expect(userPickerKeyboardAction('Enter', 0, -1)).toBeNull();
  });
});
