import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../../apps/eunenem-server/pages/App.js';
import { LANDING_FOOTER_COLS } from '../../../apps/eunenem-server/pages/lib/mocks/landing.js';
import {
  buildPainelMenu,
  PAINEL_DEMO,
} from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import {
  EUNENEM_SUPPORT_WHATSAPP_URL,
  menuItemHref,
} from '../../../apps/eunenem-server/pages/lib/painelRoutes.js';
import { pageViewProps } from '../../../apps/eunenem-server/pages/lib/rota-canonica.js';
import { TaxasEPrazosPage } from '../../../apps/eunenem-server/pages/TaxasEPrazosPage.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');

describe('public Taxas e prazos page', () => {
  it('resolves independently of a creator or session, including a trailing slash', () => {
    for (const path of ['/taxas-e-prazos', '/taxas-e-prazos/']) {
      expect(resolveRoute(path)).toEqual({ kind: 'taxas-e-prazos' });
      expect(pageViewProps(path)).toMatchObject({ rota: '/taxas-e-prazos', publico: 'visitante' });
    }
    expect(resolveRoute('/taxas-e-prazos/extra')).toEqual({ kind: 'not-found' });
  });

  it('renders without auth providers, with the fee validity next to the example and distinct payout stages', () => {
    const html = renderToStaticMarkup(createElement(TaxasEPrazosPage));
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    expect(main).toContain('8,98%');
    expect(main).toContain('paga pelo convidado');
    expect(main).toContain('não há nenhum desconto sobre o valor do presente');
    expect(main).toContain('<dd>R$ 4,49</dd>');
    expect(main).toContain('<dd>R$ 54,49</dd>');
    expect(main).toContain('<dt>Você recebe:</dt><dd>R$ 50,00</dd>');
    expect(main.indexOf('13/09/2026')).toBeLessThan(main.indexOf('id="taxas-info-exemplo"'));
    expect(main).toContain('até 10 minutos</strong> após o pagamento');
    expect(main).toContain('31 dias corridos</strong> do pagamento');
    expect(main).toContain('até 3 dias úteis</strong>');
    expect(main).toContain('Em até 3 dias úteis após a solicitação.');
    expect(main).toContain('href="/faq"');
    expect(main).toContain(`href="${EUNENEM_SUPPORT_WHATSAPP_URL}"`);
    expect(main).toContain('href="/termos-de-uso"');
  });

  it('links from the public footer without a dashboard menu entry', () => {
    expect(LANDING_FOOTER_COLS.flatMap((col) => col.links)).toContainEqual([
      'Taxas e prazos',
      '/taxas-e-prazos',
    ]);
    const account = buildPainelMenu(PAINEL_DEMO).find((group) => group.id === 'conta');
    expect(account?.items.some((item) => item.id === 'taxas-e-prazos')).toBe(false);
    expect(menuItemHref('helena', 'taxas-e-prazos', 'campaign')).toBeUndefined();
    expect(menuItemHref('helena', 'perfil')).toBe('/painel/helena/perfil');
    expect(menuItemHref('helena', 'suporte')).toBe(EUNENEM_SUPPORT_WHATSAPP_URL);
  });
});
