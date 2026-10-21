import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PainelMenu } from '../../../apps/eunenem-server/pages/components/eunenem/painel/PainelMenu.js';
import {
  buildPainelMenu,
  PAINEL_DEMO,
} from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import { menuItemHref } from '../../../apps/eunenem-server/pages/lib/painelRoutes.js';

import { trpc } from '../../../apps/eunenem-server/pages/lib/trpc.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { QueryClient, QueryClientProvider } = appRequire('@tanstack/react-query');

describe('painel — email preferences entry points (aperture-fy9vy)', () => {
  it('renders the account menu without email preference links, preserving support and profile', () => {
    const groups = buildPainelMenu(PAINEL_DEMO);
    const queryClient = new QueryClient();
    const client = trpc.createClient({ links: [] });
    const html = renderToStaticMarkup(
      createElement(
        trpc.Provider,
        { client, queryClient },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(PainelMenu, { groups, slug: 'helena' }),
        ),
      ),
    );
    expect(html).not.toContain('/email/preferencias');
    expect(html).not.toContain('/email/descadastrar');
    expect(html).not.toContain('e-mails automáticos');
    expect(html).toContain('/painel/helena/perfil');
    expect(html).toContain('https://wa.me/5531996011432');
    expect(groups.flatMap((group) => group.items).some((item) => item.id === 'emails')).toBe(false);
    expect(menuItemHref('helena', 'emails', 'c1')).toBeUndefined();
  });
});
