import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePriceToCents } from '../../../apps/eunenem-server/pages/components/eunenem/admin/catalogo/catalogo-shared.js';
import {
  contribuicaoErrorMessage,
  todosValoresUnitariosPresentesValidos,
  VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE,
  valorUnitarioPresenteInputValido,
} from '../../../apps/eunenem-server/pages/lib/contribuicao.js';

const listaSource = readFileSync(
  'apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.tsx',
  'utf8',
);
const produtosSource = readFileSync(
  'apps/eunenem-server/pages/components/eunenem/admin/catalogo/ProdutosTab.tsx',
  'utf8',
);

function functionSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('aperture-w8ajy gift minimum UI boundaries', () => {
  it('drives custom add/edit validity and inline copy from integer-cents policy', () => {
    expect(valorUnitarioPresenteInputValido('9,99')).toBe(false);
    expect(valorUnitarioPresenteInputValido('9,999')).toBe(false);
    expect(valorUnitarioPresenteInputValido('10,00')).toBe(true);
    expect(valorUnitarioPresenteInputValido('10,001')).toBe(false);
    expect(contribuicaoErrorMessage({ kind: 'minimum-value' })).toBe(
      VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE,
    );

    const form = functionSlice(listaSource, 'function PersonalizadoForm(', '/* ─── Catálogo');
    expect(form).toContain('!valorUnitarioPresenteInputValido(f.price)');
    expect(form).toContain('aria-invalid={showMinimumError || undefined}');
    expect(form).toContain('{VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE}');

    const modal = functionSlice(
      listaSource,
      'function AddGiftModal(',
      'export function ListaPresentesBody',
    );
    expect(modal).toContain('valorUnitarioPresenteInputValido(f.price)');
    const edit = functionSlice(
      listaSource,
      'export function EditItemModal(',
      'export function minimumEditableGiftQuantity',
    );
    expect(edit).toContain('valorUnitarioPresenteInputValido(f.price)');

    for (const [start, end] of [
      ['const addItem = async', 'const addCatalogItems = async'],
      ['const saveEdit = async', 'const confirmRemove = async'],
    ]) {
      const action = functionSlice(listaSource, start, end);
      expect(action.indexOf('valorUnitarioPresenteInputValido')).toBeLessThan(
        action.indexOf('mutateAsync'),
      );
      expect(action).toContain('VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE');
    }
  });

  it('blocks a mixed catalog or preset selection before its bulk mutation', () => {
    expect(todosValoresUnitariosPresentesValidos([10, 9.99])).toBe(false);
    for (const [start, end] of [
      ['const addCatalogItems = async', 'const addPresetItems = async'],
      ['const addPresetItems = async', '// Plan 0016 / aperture-1l37i'],
    ]) {
      const action = functionSlice(listaSource, start, end);
      expect(action.indexOf('todosValoresUnitariosPresentesValidos')).toBeLessThan(
        action.indexOf('createBulkMut.mutateAsync'),
      );
      expect(action).toContain('VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE');
    }
  });

  it('blocks the admin product form before create/update mutation and shows the same field error', () => {
    expect(parsePriceToCents('9,99')).toBe(999);
    expect(parsePriceToCents('9,999')).toBeNull();
    expect(parsePriceToCents('10,00')).toBe(1_000);
    expect(parsePriceToCents('10,001')).toBeNull();
    expect(parsePriceToCents('10')).toBe(1_000);
    expect(parsePriceToCents('29.90')).toBe(2_990);
    expect(parsePriceToCents('1.234,56')).toBe(123_456);
    const validate = functionSlice(
      produtosSource,
      'function validate()',
      'async function onSubmit()',
    );
    expect(validate).toContain('precoCents < 1_000');
    expect(validate).toContain('next.preco = VALOR_UNITARIO_PRESENTE_MINIMO_MESSAGE');
    const submit = functionSlice(produtosSource, 'async function onSubmit()', 'return (');
    expect(submit.indexOf('if (!v.ok) return')).toBeLessThan(submit.indexOf('mutateAsync'));
  });
});
