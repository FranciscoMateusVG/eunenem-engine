import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { AdminUsersFilterInput } from '../../../apps/eunenem-server/pages/AdminPage.js';
import {
  UserPickerDropdown,
  userPickerKeyboardAction,
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
  it('presents the user list filter as email or campaign search with no fake prefix badge', () => {
    const onChange = vi.fn();
    const tree = AdminUsersFilterInput({ value: '', onChange });
    const input = findElement(tree, (type) => type === 'input');

    expect(input).toMatchObject({
      type: 'search',
      placeholder: 'Filtrar por email ou link da campanha…',
      'aria-label': 'Filtrar usuários por email ou campanha',
    });
    expect(input?.onChange).toBeTypeOf('function');
    (input?.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'lista-francisco' },
    });
    expect(onChange).toHaveBeenCalledWith('lista-francisco');

    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain('prefix');
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
    const second = findElement(
      tree,
      (_type, props) => props.id === 'picker-results-opt-1',
    );

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
