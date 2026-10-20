import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  ManualResolutionActions,
  RecoveryCandidatesTable,
  RecoveryConfirmation,
  RecoveryResolvedElsewhere,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/RepasseRecoveryActions.js';
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

it('45h33 candidate evidence is a table with E2E, amount, date and classification', () => {
  const html = renderToStaticMarkup(
    createElement(RecoveryCandidatesTable, {
      candidates: [
        {
          e2eId: 'E_SYNTHETIC',
          amountCents: 19500,
          dataMovimento: '2026-10-19',
          destination: 'unknown',
        },
      ],
    }),
  );
  for (const text of ['<table', 'E_SYNTHETIC', '195,00', '2026-10-19', 'destino não identificado'])
    expect(html).toContain(text);
});
it.each(['paid', 'retry'])('45h33 %s requires an explicit modal confirmation', (mode) => {
  const html = renderToStaticMarkup(
    createElement(RecoveryConfirmation, {
      mode,
      amountCents: 19500,
      reference: 'BANK_REFERENCE',
      reason: 'Motivo sintético',
      busy: false,
      onConfirm() {},
      onClose() {},
    }),
  );
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('Voltar');
  expect(html).toContain(mode === 'paid' ? 'BANK_REFERENCE' : 'pagar duas vezes');
});

it('45h33 reports a competing resolution without claiming success', () => {
  const html = renderToStaticMarkup(
    createElement(RecoveryResolvedElsewhere, { status: 'pago', onRefresh() {} }),
  );
  expect(html).toContain('já resolvido por outra ação');
  expect(html).toContain('Nenhuma alteração');
  expect(html).toContain('pago');
});
