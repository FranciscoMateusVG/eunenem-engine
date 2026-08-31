import { describe, expect, it } from 'vitest';

import {
  buildPainelMenu,
  PAINEL_DEMO,
} from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import {
  deriveGiftListUnitCounts,
  derivePainelCounts,
} from '../../../apps/eunenem-server/pages/lib/painel-counts.js';

describe('painel count synchronisation', () => {
  it('uses purchased gift units for both the received row and header strip', () => {
    const counts = derivePainelCounts({
      summary: { totalPresentes: 2, totalPresentesItensCount: 3, totalPresentesUnidades: 5 },
      guests: [],
    });
    const snapshot = {
      ...PAINEL_DEMO,
      giftsClaimed: counts.giftsReceived,
      presentesStripCount: counts.giftsReceived,
      guestsTotal: counts.guestsTotal,
      guestsConfirmed: counts.guestsConfirmed,
    };
    const menu = buildPainelMenu(snapshot);
    const received = menu.flatMap((group) => group.items).find((item) => item.id === 'presentes');

    expect(counts.giftsReceived).toBe(5);
    expect(snapshot.presentesStripCount).toBe(5);
    expect(received?.sub).toContain('5 presentes');
  });

  it('falls back through item count to payment count for older cached summaries', () => {
    expect(
      derivePainelCounts({
        summary: { totalPresentes: 2, totalPresentesItensCount: 4 },
        guests: [],
      }).giftsReceived,
    ).toBe(4);
  });

  it('counts all guests but only confirmed presence in both guest labels', () => {
    const counts = derivePainelCounts({
      summary: { totalPresentes: 0, totalPresentesItensCount: 0 },
      guests: [
        { presenca: 'sim' },
        { presenca: 'sim' },
        { presenca: 'talvez' },
        { presenca: 'enviado' },
        { presenca: 'nao' },
        { presenca: 'nao_enviado' },
      ],
    });
    const menu = buildPainelMenu({
      ...PAINEL_DEMO,
      guestsTotal: counts.guestsTotal,
      guestsConfirmed: counts.guestsConfirmed,
    });
    const guests = menu
      .flatMap((group) => group.items)
      .find((item) => item.id === 'lista-convidados');

    expect(counts).toMatchObject({ guestsTotal: 6, guestsConfirmed: 2 });
    expect(guests?.sub).toBe('6 convidados · 2 confirmados');
    expect(guests?.badge?.text).toBe('2/6');
  });

  it('falls back to the legacy payment count when item count is absent', () => {
    expect(derivePainelCounts({ summary: { totalPresentes: 3 }, guests: null })).toEqual({
      giftsReceived: 3,
      guestsTotal: 0,
      guestsConfirmed: 0,
    });
  });
});

describe('gift-list unit synchronisation', () => {
  it('counts partial and fully claimed quantities in the same unit as the summary', () => {
    expect(
      deriveGiftListUnitCounts([
        { quantidade: 10, quantidadeRestante: 5 },
        { quantidade: 1, quantidadeRestante: 0 },
        { quantidade: 1, indisponivel: true },
      ]),
    ).toEqual({ total: 12, claimed: 7 });
  });

  it('preserves legacy one-row-per-gift behavior when quantity fields are absent', () => {
    expect(deriveGiftListUnitCounts([{ indisponivel: true }, { indisponivel: false }])).toEqual({
      total: 2,
      claimed: 1,
    });
  });
});
