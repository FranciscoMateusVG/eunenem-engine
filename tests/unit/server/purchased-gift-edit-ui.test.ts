import { describe, expect, it } from 'vitest';
import {
  giftActionAvailability,
  groupContribuicoes,
  minimumEditableGiftQuantity,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ListaPresentesBody.js';

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
