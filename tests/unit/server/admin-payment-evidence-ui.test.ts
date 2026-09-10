import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  PaymentEvidenceFilters,
  type PaymentEvidenceRow,
  PaymentEvidenceTable,
  paymentEvidenceSearchInput,
  ReferenceResolutionNotice,
  UnmatchedPaymentEvidenceTable,
} from '../../../apps/eunenem-server/pages/AdminPagamentosPage.js';

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

function findElement(
  node: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  const props = element.props ?? {};
  if (predicate(element.type, props)) return props;
  return findElement(props.children, predicate);
}

function row(overrides: Partial<PaymentEvidenceRow> = {}): PaymentEvidenceRow {
  return {
    paymentId: '20000000-0000-4000-8000-000000000001',
    campaignId: '10000000-0000-4000-8000-000000000001',
    campaignTitle: 'Campanha teste',
    method: 'credit_card',
    status: 'aprovado',
    createdAt: '2026-09-08T14:00:00.000Z',
    updatedAt: '2026-09-08T14:01:00.000Z',
    amounts: {
      contributionCents: 1_800,
      feeCents: 100,
      surchargeCents: 100,
      receiverCents: 1_700,
      paidCents: 2_000,
    },
    providerEvidence: {
      provider: 'stripe',
      normalizedStatus: 'aprovado',
      rawStatus: 'succeeded',
      providerAmountCents: 1_900,
      providerRecordedAt: '2026-09-08T14:02:00.000Z',
      checkoutSessionRef: 'cs_saved',
      paymentIntentRef: 'pi_saved',
      chargeRef: 'ch_saved',
      interE2eRef: null,
      externalTransactionRef: 'txn_saved',
    },
    ...overrides,
  };
}

describe('PaymentEvidenceTable', () => {
  it('renders bounded saved evidence for Stripe and Inter without provider fetching', () => {
    const html = renderToStaticMarkup(
      React.createElement(PaymentEvidenceTable, {
        rows: [
          row(),
          row({
            paymentId: '20000000-0000-4000-8000-000000000002',
            method: 'pix',
            providerEvidence: {
              provider: 'inter',
              normalizedStatus: 'aprovado',
              rawStatus: 'CONCLUIDA',
              providerAmountCents: 2_000,
              providerRecordedAt: '2026-09-08T14:03:00.000Z',
              checkoutSessionRef: null,
              paymentIntentRef: null,
              chargeRef: null,
              interE2eRef: 'E0000000000000000000000000000001',
              externalTransactionRef: 'inter-saved',
            },
          }),
        ],
      }),
    );

    expect(html).toContain('Stripe');
    expect(html).toContain('Inter');
    expect(html).toContain('cs_saved');
    expect(html).toContain('pi_saved');
    expect(html).toContain('ch_saved');
    expect(html).toContain('E0000000000000000000000000000001');
    expect(html).toContain('taxa plataforma');
    expect(html).toContain('adicional cartão');
    expect(html).toContain('Total previsto');
    expect(html).toContain('Valor registrado pelo provedor');
    expect(html).toContain('20,00');
    expect(html).toContain('19,00');
    expect(html).not.toContain('>Pago ');
    expect(html).not.toContain('rawPayload');
    expect(html).not.toContain('signatureHeader');
  });

  it('shows explicit absence instead of manufacturing a provider or reference', () => {
    const html = renderToStaticMarkup(
      React.createElement(PaymentEvidenceTable, {
        rows: [
          row({
            status: 'pendente',
            providerEvidence: {
              provider: null,
              normalizedStatus: null,
              rawStatus: null,
              providerAmountCents: null,
              providerRecordedAt: null,
              checkoutSessionRef: null,
              paymentIntentRef: null,
              chargeRef: null,
              interE2eRef: null,
              externalTransactionRef: null,
            },
          }),
        ],
      }),
    );

    expect(html).toContain('provedor não registrado');
    expect(html).toContain('sem estado normalizado');
    expect(html).toContain('sem estado salvo');
    expect(html).toContain('sem referência salva');
    expect(html).toContain('Total previsto');
    expect(html).not.toContain('>Pago ');
  });
});

describe('PaymentEvidenceFilters', () => {
  it('renders and wires independent payer, campaign and exact-reference fields', () => {
    const onSearchChange = vi.fn();
    const onClearSearch = vi.fn();
    const tree = PaymentEvidenceFilters({
      provider: null,
      status: null,
      search: {
        payerQuery: 'Dana',
        campaignQuery: 'lista-francisco',
        exactReference: 'E0000000000000000000000000000001',
      },
      onProviderChange: () => undefined,
      onStatusChange: () => undefined,
      onSearchChange,
      onClearSearch,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('Pagador');
    expect(html).toContain('Pessoa ou campanha');
    expect(html).toContain('Referência de pagamento / Inter');
    expect(html).toContain('Nome, título, link ou slug da campanha');
    expect(html).toContain('UUID, txid, e2e, cs_, pi_, ch_ ou evt_');
    expect(html).toContain('maxLength="160"');
    expect(html).toContain('maxLength="1024"');
    expect(html).toContain('maxLength="255"');
    expect(html.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('min-w-0');
    expect(html).toContain('Limpar buscas');

    const payer = findElement(
      tree,
      (_type, props) => props.ariaLabel === 'Filtrar por nome ou email do pagador',
    );
    expect(payer?.onChange).toBeTypeOf('function');
    (payer?.onChange as (value: string) => void)('Dana Lima');
    expect(onSearchChange).toHaveBeenCalledWith('payerQuery', 'Dana Lima');

    const clear = findElement(
      tree,
      (type, props) => type === 'button' && props.children === 'Limpar buscas',
    );
    expect(clear?.disabled).toBe(false);
    (clear?.onClick as () => void)();
    expect(onClearSearch).toHaveBeenCalledOnce();
  });

  it('normalizes searches into the exact listEvidencePaginated input names', () => {
    expect(
      paymentEvidenceSearchInput({
        payerQuery: '  Dana  ',
        campaignQuery: '  lista-francisco ',
        exactReference: '  cs_saved  ',
      }),
    ).toEqual({
      payerQuery: 'Dana',
      campaignQuery: 'lista-francisco',
      exactReference: 'cs_saved',
    });
    expect(
      paymentEvidenceSearchInput({
        payerQuery: ' ',
        campaignQuery: '',
        exactReference: '  ',
      }),
    ).toEqual({
      payerQuery: undefined,
      campaignQuery: undefined,
      exactReference: undefined,
    });
  });

  it('states exact-reference absence and ambiguity without inferring provider absence', () => {
    const absent = renderToStaticMarkup(
      React.createElement(ReferenceResolutionNotice, {
        exactReference: 'reference',
        resolution: 'absent',
      }),
    );
    expect(absent).toContain('Nenhuma evidência local');
    expect(absent).toContain('não prova ausência no provedor');

    const ambiguous = renderToStaticMarkup(
      React.createElement(ReferenceResolutionNotice, {
        exactReference: 'reference',
        resolution: 'ambiguous',
      }),
    );
    expect(ambiguous).toContain('mais de um pagamento local');
    expect(ambiguous).toContain('Nenhuma linha foi escolhida');

    expect(
      renderToStaticMarkup(
        React.createElement(ReferenceResolutionNotice, {
          exactReference: 'reference',
          resolution: 'not_requested',
        }),
      ),
    ).toBe('');

    expect(
      renderToStaticMarkup(
        React.createElement(ReferenceResolutionNotice, {
          exactReference: 'reference',
          resolution: 'unique',
        }),
      ),
    ).toBe('');
  });

  it('distinguishes mixed linked and unmatched evidence without claiming payment ownership', () => {
    const mixed = renderToStaticMarkup(
      React.createElement(ReferenceResolutionNotice, {
        exactReference: 'pi_mixed',
        resolution: 'mixed',
      }),
    );
    expect(mixed).toContain('pagamento local');
    expect(mixed).toContain('recebimentos sem vínculo');
    expect(mixed).toContain('não confirma que pertencem ao mesmo pagamento');
  });
});

describe('UnmatchedPaymentEvidenceTable', () => {
  const rows = [
    {
      archiveId: '21000000-0000-4000-8000-000000000001',
      provider: 'stripe' as const,
      matchedReferenceType: 'stripe_payment_intent' as const,
      matchedReference: 'pi_saved',
      providerEventId: 'evt_saved',
      eventType: 'payment_intent.succeeded',
      receivedAt: '2026-09-08T14:00:00.000Z',
      processedAt: '2026-09-08T14:01:00.000Z',
      trust: 'stripe_configured_secret_verified' as const,
      processingState: 'processed' as const,
      failureCategory: null,
      linkState: 'unmatched' as const,
    },
    {
      archiveId: '21000000-0000-4000-8000-000000000002',
      provider: 'inter' as const,
      matchedReferenceType: 'inter_txid' as const,
      matchedReference: 'T'.repeat(26),
      providerEventId: `${'T'.repeat(26)}:${'E'.repeat(32)}`,
      eventType: 'pix.recebido',
      receivedAt: '2026-09-08T14:02:00.000Z',
      processedAt: null,
      trust: 'inter_unsigned_hint' as const,
      processingState: 'failed' as const,
      failureCategory: 'charge_requery_failed' as const,
      linkState: 'unmatched' as const,
    },
  ];

  it('renders honest trust and local-processing evidence without a paid or replay claim', () => {
    const html = renderToStaticMarkup(
      React.createElement(UnmatchedPaymentEvidenceTable, { rows, truncated: false }),
    );
    expect(html).toContain('sem pagamento local vinculado');
    expect(html).toContain('Não comprova que o pagamento pertence à plataforma');
    expect(html).toContain('nem que o dinheiro chegou');
    expect(html).toContain('Assinatura verificada pelo segredo configurado neste endpoint');
    expect(html).toContain('Aviso não assinado; não confirmado pelo Inter');
    expect(html).toContain('Processamento local concluído');
    expect(html).toContain('Falha no processamento local');
    expect(html).toContain('charge_requery_failed');
    expect(html).not.toContain('Pago');
    expect(html).not.toContain('Reprocessar');
    expect(html).not.toContain('rawPayload');
    expect(html).not.toContain('signatureHeader');
  });

  it('shows that the hard-capped result is incomplete', () => {
    const html = renderToStaticMarkup(
      React.createElement(UnmatchedPaymentEvidenceTable, { rows: [rows[0]], truncated: true }),
    );
    expect(html).toContain('20 evidências mais recentes');
    expect(html).toContain('Existem outros registros locais');
  });
});
