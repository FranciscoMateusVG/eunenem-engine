import { describe, expect, it } from 'vitest';
import {
  buildPainelMenu,
  PAINEL_DEMO,
} from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import { menuItemHref } from '../../../apps/eunenem-server/pages/lib/painelRoutes.js';

describe('painel — e-mails automáticos row (aperture-tykv8)', () => {
  it('sits in "conta & ajuda" before support and opens the session-backed preferences page', () => {
    const conta = buildPainelMenu(PAINEL_DEMO).find((g) => g.id === 'conta');
    const ids = conta?.items.map((i) => i.id) ?? [];
    expect(ids.indexOf('emails')).toBe(ids.indexOf('suporte') - 1);
    expect(conta?.items.find((i) => i.id === 'emails')).toMatchObject({
      label: 'e-mails automáticos',
    });
    expect(menuItemHref('helena', 'emails', 'c1')).toBe('/email/preferencias');
  });
});
