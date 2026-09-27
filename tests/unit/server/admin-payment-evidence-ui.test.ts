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
    campaignSlug: 'cha-da-lia',
    administrators: {
      shown: [
        {
          idConta: '12000000-0000-4000-8000-000000000001',
          displayName: 'Ana Administradora',
          email: 'ana@example.test',
          hasUserRow: true,
        },
      ],
      total: 1,
    },
    publicOwnerSlug: 'ana-admin',
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

describe('PaymentEvidenceTable — usuário e links da campanha (aperture-9bpre)', () => {
  const PAYMENT = '20000000-0000-4000-8000-000000000001';
  const CAMPAIGN = '10000000-0000-4000-8000-000000000001';

  function render(overrides: Partial<PaymentEvidenceRow> = {}): string {
    return renderToStaticMarkup(
      React.createElement(PaymentEvidenceTable, { rows: [row(overrides)] }),
    );
  }

  it('lista os administradores reais como links para o detalhe do usuário', () => {
    const html = render();
    expect(html).toContain('Usuário (administradores)');
    expect(html).toContain('href="/admin/usuario/12000000-0000-4000-8000-000000000001"');
    expect(html).toContain('Ana Administradora');
    expect(html).toContain('ana@example.test');
  });

  it('separa Ver pagamento, Campanha no admin e Abrir campanha pública', () => {
    const html = render();
    // O destino antigo do título continua existindo, com rótulo próprio.
    expect(html).toMatch(new RegExp(`href="/admin/pagamento/${PAYMENT}"[^>]*>Ver pagamento`));
    expect(html).toContain(`href="/admin/campanha/${CAMPAIGN}"`);
    expect(html).toContain('Campanha no admin');
    // Link público pelo builder canônico, com slug de campanha.
    expect(html).toContain('href="/pagina/ana-admin/cha-da-lia"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Abrir campanha pública');
    // O título deixou de ser um link disfarçado de campanha.
    expect(html).not.toContain(`href="/admin/pagamento/${PAYMENT}">Campanha teste`);
    expect(html).not.toContain('href="/c/');
  });

  it('campanha sem slug usa o caminho canônico com o id', () => {
    const html = render({ campaignSlug: null });
    expect(html).toContain(`href="/pagina/ana-admin/c/${CAMPAIGN}"`);
  });

  it('sem administrador elegível: texto explícito, nenhum link público', () => {
    const html = render({
      publicOwnerSlug: null,
      administrators: {
        shown: [
          {
            idConta: '12000000-0000-4000-8000-0000000000ff',
            displayName: null,
            email: null,
            hasUserRow: false,
          },
        ],
        total: 1,
      },
    });
    expect(html).toContain('página pública indisponível');
    expect(html).not.toContain('Abrir campanha pública');
    expect(html).not.toContain('href="/pagina/');
    // Sem cadastro: id curto, nenhum nome inventado, nenhum link morto.
    expect(html).toContain('conta 12000000…');
    expect(html).toContain('sem cadastro nesta plataforma');
    expect(html).not.toContain('href="/admin/usuario/12000000-0000-4000-8000-0000000000ff"');
  });

  it('acima de cinco administradores mostra +N com link para a lista completa', () => {
    const shown = Array.from({ length: 5 }, (_, i) => ({
      idConta: `12000000-0000-4000-8000-00000000000${i + 1}`,
      displayName: `Pessoa ${i + 1}`,
      email: `pessoa${i + 1}@example.test`,
      hasUserRow: true,
    }));
    const html = render({ administrators: { shown, total: 7 } });
    expect(html).toContain('+2 · ver os 7 administradores');
    expect(html).toContain(`href="/admin/campanha/${CAMPAIGN}"`);
    expect(html.match(/href="\/admin\/usuario\//g)).toHaveLength(5);
  });

  it('link público existe mesmo quando nenhum dos exibidos é elegível', () => {
    const shown = Array.from({ length: 5 }, (_, i) => ({
      idConta: `12000000-0000-4000-8000-00000000000${i + 1}`,
      displayName: null,
      email: null,
      hasUserRow: false,
    }));
    const html = render({
      administrators: { shown, total: 6 },
      publicOwnerSlug: 'sexta-pessoa',
    });
    expect(html).toContain('href="/pagina/sexta-pessoa/cha-da-lia"');
    expect(html).not.toContain('página pública indisponível');
  });

  it('campanha sem administrador registrado diz isso', () => {
    const html = render({ administrators: { shown: [], total: 0 }, publicOwnerSlug: null });
    expect(html).toContain('sem administrador registrado');
  });
});

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
