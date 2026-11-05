import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  AprovarEscolha,
  bankTransferRefDaEscolha,
} from '../../../apps/eunenem-server/pages/AdminRepasseDetailPage.js';
import {
  ManualResolutionActions,
  mensagemErroAdmin,
  RecoveryActionButton,
  RecoveryCandidatesTable,
  RecoveryConfirmation,
  RecoveryResolvedElsewhere,
  ReenvioPeloInterActions,
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
  expect(html).toContain('Tentar de novo');
  expect(html).not.toContain('Motivo obrigatório');
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
      busy: false,
      onConfirm() {},
      onClose() {},
    }),
  );
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('Voltar');
  expect(html).toContain(mode === 'paid' ? 'marcado como pago' : 'recebe duas vezes');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('<input');
});

it('45h33 reports a competing resolution without claiming success', () => {
  const html = renderToStaticMarkup(
    createElement(RecoveryResolvedElsewhere, { status: 'pago', onRefresh() {} }),
  );
  expect(html).toContain('já resolvido por outra ação');
  expect(html).toContain('Nenhuma alteração');
  expect(html).toContain('pago');
});

it('aperture-mno2s manual-resolution actions render as styled, visibly clickable buttons', () => {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [] });
  const html: string = renderToStaticMarkup(
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
  for (const label of ['Confirmei que saiu', 'Tentar de novo']) {
    const tag = html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`))?.[0] ?? '';
    expect(tag, label).toContain('type="button"');
    expect(tag, label).toMatch(/class="[^"]*\bborder\b[^"]*\bbg-[a-z]+-\d+/);
    expect(tag, label).toContain('cursor-pointer');
  }
});

it('aperture-mno2s a disabled action button shows why it is disabled', () => {
  const html: string = renderToStaticMarkup(
    createElement(
      RecoveryActionButton,
      {
        variant: 'primary',
        disabled: true,
        hint: 'Preencha o motivo (mín. 10 caracteres)',
        onClick() {},
      },
      'Autorizar uma nova tentativa',
    ),
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-describedby=');
  expect(html).toContain('Preencha o motivo');
  expect(html).toContain('cursor-not-allowed');
});

it('aperture-puali "Enviar pelo Inter agora" is one button, no typed amount, no attestation', () => {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [] });
  const html: string = renderToStaticMarkup(
    createElement(
      trpc.Provider,
      { client, queryClient },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ReenvioPeloInterActions, {
          repasse: { idRepasse: 'synthetic', amountCents: 4500 },
        }),
      ),
    ),
  );
  expect(html).toContain('Enviar pelo Inter agora');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('disabled=""');
});

it('aperture-puali admin errors are short Portuguese, never raw Zod/JSON', () => {
  const raw = '[{"code":"too_small","path":["motivo"],"message":"Too small"}]';
  expect(mensagemErroAdmin(raw)).not.toContain('too_small');
  expect(mensagemErroAdmin(raw)).toMatch(/tente novamente/i);
  expect(mensagemErroAdmin('{"code":"x"}')).toMatch(/tente novamente/i);
  expect(mensagemErroAdmin('')).toMatch(/tente novamente/i);
  expect(mensagemErroAdmin('Repasse não encontrado.')).toBe('Repasse não encontrado.');
});

it('aperture-mno2s approve modal is an explicit choice: send via Inter vs already paid outside (reference required)', () => {
  const props = {
    amountCents: 4500,
    destinationLabel: 'Itaú (341) · ag 0123 · conta 456789-0',
    choice: null,
    reference: '',
    onChoice() {},
    onReference() {},
    disabled: false,
  };
  const html: string = renderToStaticMarkup(createElement(AprovarEscolha, props));
  expect(html).toContain('Enviar pelo Inter agora');
  expect(html).toContain('Já paguei por fora');
  expect(html).toContain('Itaú (341)');
  expect(html).toContain('45,00');
  expect(html).not.toMatch(/opcional/i);
  expect(html).not.toContain('Pode preencher depois');
  const paid: string = renderToStaticMarkup(
    createElement(AprovarEscolha, { ...props, choice: 'por_fora' }),
  );
  expect(paid).toMatch(/refer[êe]ncia banc[áa]ria obrigat[óo]ria/i);
  expect(bankTransferRefDaEscolha('enviar', '  x ')).toBeNull();
  expect(bankTransferRefDaEscolha('por_fora', '  PIX-1 ')).toBe('PIX-1');
  expect(bankTransferRefDaEscolha('por_fora', '  ')).toBeUndefined();
  expect(bankTransferRefDaEscolha(null, 'PIX-1')).toBeUndefined();
});
