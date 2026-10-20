import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { ManualResolutionActions } from '../../../apps/eunenem-server/pages/components/eunenem/admin/RepasseRecoveryActions.js';
import { trpc } from '../../../apps/eunenem-server/pages/lib/trpc.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { QueryClient, QueryClientProvider } = appRequire('@tanstack/react-query');
it('45h33 renders both manual exits even without reconciliation candidates; rendering makes no bank request', () => {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [] });
  const html = renderToStaticMarkup(
    createElement(
      trpc.Provider,
      { client, queryClient },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ManualResolutionActions, {
          repasse: { idRepasse: 'synthetic', needsManualResolution: false, searchCandidates: [] },
        }),
      ),
    ),
  );
  expect(html).toContain('Confirmei que saiu');
  expect(html).toContain('Confirmei que NÃO saiu');
  expect(html).toContain('Nenhuma consulta envia dinheiro');
});
