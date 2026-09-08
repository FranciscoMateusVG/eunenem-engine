import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  type PaymentEvidenceRow,
  PaymentEvidenceTable,
} from '../../../apps/eunenem-server/pages/AdminPagamentosPage.js';

const appRequire = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

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
