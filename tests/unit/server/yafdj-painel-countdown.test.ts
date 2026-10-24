import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { PainelHeaderCard } from '../../../apps/eunenem-server/pages/components/eunenem/painel/PainelHeaderCard.js';
import { TweaksProvider } from '../../../apps/eunenem-server/pages/components/eunenem/TweaksContext.js';
import { PAINEL_DEMO } from '../../../apps/eunenem-server/pages/lib/mocks/painelDemo.js';
import { trpc } from '../../../apps/eunenem-server/pages/lib/trpc.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react');
const { renderToStaticMarkup } = appRequire('react-dom/server');
const { QueryClient, QueryClientProvider } = appRequire('@tanstack/react-query');
afterEach(() => vi.useRealTimers());

function render(date: string, now = '2026-10-23T15:00:00Z'): string {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    createElement(
      trpc.Provider,
      { client: trpc.createClient({ links: [] }), queryClient },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          TweaksProvider,
          { initialState: { targetDate: date } },
          createElement(PainelHeaderCard, { snapshot: PAINEL_DEMO, slug: 'synthetic' }),
        ),
      ),
    ),
  );
  queryClient.clear();
  return html;
}

it('past event says it happened and keeps its date, never countdown zero', () => {
  const html = render('2026-07-31');
  expect(html).toContain('o evento já aconteceu');
  expect(html).toContain('31 jul 2026');
  expect(html).not.toContain('falta pouco');
  expect(html).not.toContain('0 dias para o evento');
});
it('today says é hoje instead of 0 days', () => {
  const html = render('2026-10-23');
  expect(html).toContain('é hoje');
  expect(html).not.toContain('0 dias para o evento');
  expect(html).not.toContain('falta pouco');
});
it('future keeps countdown by calendar day, including tomorrow late at night', () => {
  expect(render('2026-10-25')).toContain('2 dias para o evento');
  expect(render('2026-10-24', '2026-10-24T02:59:59Z')).toContain('1 dia para o evento');
});
it('uses midnight São Paulo, not UTC or the host timezone', () => {
  expect(render('2026-10-23', '2026-10-24T02:59:59Z')).toContain('é hoje');
  expect(render('2026-10-23', '2026-10-24T03:00:00Z')).toContain('o evento já aconteceu');
});
it('missing or invalid date retains the no-date message', () => {
  for (const date of ['', 'invalid', '2026-02-30']) {
    const html = render(date);
    expect(html).toContain('sua página tá no ar');
    expect(html).not.toContain('dias para o evento');
  }
});
