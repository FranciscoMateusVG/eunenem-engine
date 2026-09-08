import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  GiftCard,
  giftActionAvailability,
  groupContribuicoes,
  minimumEditableGiftQuantity,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.js';

function findElementProps(
  node: unknown,
  attribute: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementProps(child, attribute, value);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;

  const props = (node as { props?: unknown }).props;
  if (!props || typeof props !== 'object') return undefined;
  const record = props as Record<string, unknown>;
  if (record[attribute] === value) return record;
  return findElementProps(record.children, attribute, value);
}

describe('purchased gift edit controls', () => {
  it('keeps edit enabled and disables removal with an explicit reason', () => {
    const sold = giftActionAvailability(true, 1);
    expect(sold.editDisabled).toBe(false);
    expect(sold.editReason).toBeUndefined();
    expect(sold.removeDisabled).toBe(true);
    expect(sold.removeReason).toBe('Não é possível remover porque este presente já foi comprado.');

    const unsold = giftActionAvailability(false, 1);
    expect(unsold.editDisabled).toBe(false);
    expect(unsold.editReason).toBeUndefined();
    expect(unsold.removeDisabled).toBe(false);
    expect(unsold.removeReason).toBeUndefined();
  });

  it('exposes a focusable disabled trash state and explanation for a purchased gift', () => {
    const onRemove = vi.fn();
    const [gift] = groupContribuicoes([
      {
        id: 'gift-1',
        nome: 'Fralda',
        valor: 3000,
        imagemUrl: null,
        grupo: 'fraldas',
        quantidade: 1,
        quantidadeRestante: 0,
        indisponivel: true,
      },
    ]);
    expect(gift).toBeDefined();
    if (!gift) throw new Error('expected a grouped gift');

    const tree = GiftCard({ item: gift, onEdit: () => undefined, onRemove });
    const removeButton = findElementProps(tree, 'data-testid', 'gift-remove-btn');
    const reason = findElementProps(tree, 'id', 'gift-remove-reason-gift-1');

    expect(removeButton).toMatchObject({
      className: 'danger is-disabled',
      'aria-disabled': true,
      'aria-describedby': 'gift-remove-reason-gift-1',
      title: 'Não é possível remover porque este presente já foi comprado.',
    });
    expect(removeButton).not.toHaveProperty('disabled');
    expect(reason).toMatchObject({
      className: 'sr-only',
      children: 'Não é possível remover porque este presente já foi comprado.',
    });

    expect(removeButton?.onClick).toBeTypeOf('function');
    (removeButton?.onClick as () => void)();
    expect(onRemove).not.toHaveBeenCalled();

    const css = readFileSync('apps/eunenem-server/tailwind.css', 'utf8');
    expect(css).toContain('.lista-card-actions button.is-disabled');
    expect(css).toMatch(/button\.is-disabled[\s\S]*cursor: not-allowed;/);
  });

  it('keeps the unsold trash control active', () => {
    const onRemove = vi.fn();
    const [gift] = groupContribuicoes([
      {
        id: 'gift-available',
        nome: 'Cueiro',
        valor: 2000,
        imagemUrl: null,
        grupo: 'roupa',
        quantidade: 1,
        quantidadeRestante: 1,
        indisponivel: false,
      },
    ]);
    if (!gift) throw new Error('expected a grouped gift');

    const tree = GiftCard({ item: gift, onEdit: () => undefined, onRemove });
    const removeButton = findElementProps(tree, 'data-testid', 'gift-remove-btn');

    expect(removeButton).toMatchObject({ className: 'danger' });
    expect(removeButton?.['aria-disabled']).toBeUndefined();
    expect(removeButton?.onClick).toBeTypeOf('function');
    (removeButton?.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith(gift);
  });

  it('disables ambiguous legacy grouped editing with a clear reason', () => {
    const soldLegacyGroup = giftActionAvailability(true, 2);

    expect(soldLegacyGroup.editDisabled).toBe(true);
    expect(soldLegacyGroup.editReason).toBe(
      'Edição indisponível: este presente reúne registros antigos agrupados.',
    );
    expect(soldLegacyGroup.removeDisabled).toBe(true);
    expect(soldLegacyGroup.removeReason).toBe(
      'Não é possível remover porque este presente já foi comprado.',
    );

    const unsoldLegacyGroup = giftActionAvailability(false, 2);
    expect(unsoldLegacyGroup.editDisabled).toBe(true);
    expect(unsoldLegacyGroup.removeDisabled).toBe(false);
  });

  it('uses the actual approved count as the edit floor, including oversold rows', () => {
    const [gift] = groupContribuicoes([
      {
        id: 'gift-1',
        nome: 'Fralda',
        valor: 3000,
        imagemUrl: null,
        grupo: 'fraldas',
        quantidade: 3,
        quantidadeRestante: -1,
        indisponivel: true,
      },
    ]);

    expect(gift?.received).toBe(4);
    expect(gift?.qty).toBe(3);
    expect(minimumEditableGiftQuantity(gift?.received ?? 0)).toBe(4);
    expect(minimumEditableGiftQuantity(1)).toBe(1);
    expect(minimumEditableGiftQuantity(0)).toBe(1);
  });

  it('aggregates actual purchased quantities across legacy grouped rows', () => {
    const [gift] = groupContribuicoes([
      {
        id: 'gift-1',
        nome: 'Fralda',
        valor: 3000,
        imagemUrl: null,
        grupo: 'fraldas',
        quantidade: 1,
        quantidadeRestante: 0,
        indisponivel: true,
      },
      {
        id: 'gift-2',
        nome: 'Fralda',
        valor: 3000,
        imagemUrl: null,
        grupo: 'fraldas',
        quantidade: 1,
        quantidadeRestante: 1,
        indisponivel: false,
      },
    ]);

    expect(gift?.ids).toEqual(['gift-1', 'gift-2']);
    expect(gift?.qty).toBe(2);
    expect(gift?.received).toBe(1);
    expect(minimumEditableGiftQuantity(gift?.received ?? 0)).toBe(1);
  });
});
