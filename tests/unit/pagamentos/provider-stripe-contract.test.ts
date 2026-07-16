import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { SURCHARGE_LINE_ITEM_NAME } from '../../../src/adapters/pagamentos/card-surcharge.js';
import type { CriarSessaoCheckoutInput } from '../../../src/adapters/pagamentos/checkout-session-provider.js';
import { PagamentoProviderStripe } from '../../../src/adapters/pagamentos/provider.stripe.js';

/**
 * Contract test for the visitor cart → Stripe checkout handoff (aperture-44mfy).
 *
 * The visitor-cart e2e (`visitor-cart-checkout.spec.ts`) runs against the FAKE
 * provider and only asserts the tRPC 2xx + drawer phase flip — it never
 * verifies what arguments the REAL adapter sends to Stripe. That handoff
 * contract (embedded ui_mode, payment_method_types per rail, the surcharge
 * line item, the reserved metadata keys, the idempotency key) is the thing a
 * Stripe SDK-shape drift or a careless refactor would silently break.
 *
 * This test drives the real `PagamentoProviderStripe.criarSessaoCheckout`
 * against a MOCKED Stripe client (a vi.fn spy on checkout.sessions.create) so
 * the exact call arguments are asserted deterministically — no network, no key.
 */

function mockStripe() {
  const create = vi.fn().mockResolvedValue({
    id: 'cs_test_contract',
    client_secret: 'cs_test_contract_secret',
  });
  const stripe = {
    checkout: { sessions: { create } },
  } as unknown as Stripe;
  return { stripe, create };
}

function baseInput(overrides?: Partial<CriarSessaoCheckoutInput>): CriarSessaoCheckoutInput {
  return {
    idPagamento: 'pag_contract_1' as never,
    idIntencaoPagamento: 'int_contract_1' as never,
    idCampanha: 'camp_contract_1' as never,
    idContribuicao: 'contrib_contract_1' as never,
    idOpcaoContribuicao: 'opcao_contract_1' as never,
    tipoOpcao: 'presente' as never,
    nomeItem: 'Fralda Premium',
    amountCents: 8000 as never,
    metodo: 'pix' as never,
    surchargeCents: 0,
    returnUrl: 'https://eunenem.example/pagina/x/sucesso?session_id={CHECKOUT_SESSION_ID}',
    ...overrides,
  };
}

/** Grab the (params, options) the adapter passed to checkout.sessions.create. */
function callArgs(create: ReturnType<typeof vi.fn>) {
  const [params, options] = create.mock.calls[0] as [
    Stripe.Checkout.SessionCreateParams,
    Stripe.RequestOptions,
  ];
  return { params, options };
}

describe('PagamentoProviderStripe.criarSessaoCheckout — Stripe handoff contract', () => {
  it('always creates an embedded payment session and returns the session ids', async () => {
    const { stripe, create } = mockStripe();
    const provider = new PagamentoProviderStripe({ stripe, clock: () => new Date(0) });

    const result = await provider.criarSessaoCheckout(baseInput());

    expect(create).toHaveBeenCalledTimes(1);
    const { params } = callArgs(create);
    expect(params.mode).toBe('payment');
    expect(params.ui_mode).toBe('embedded');
    expect(params.customer_creation).toBe('if_required');
    expect(params.return_url).toBe(baseInput().returnUrl);

    // The adapter maps Stripe's response onto our provider-agnostic result.
    expect(result).toEqual({
      sessionId: 'cs_test_contract',
      clientSecret: 'cs_test_contract_secret',
      externalRef: 'cs_test_contract',
    });
  });

  it('PIX → payment_method_types ["pix"] and NO surcharge line item', async () => {
    const { stripe, create } = mockStripe();
    const provider = new PagamentoProviderStripe({ stripe, clock: () => new Date(0) });

    await provider.criarSessaoCheckout(baseInput({ metodo: 'pix' as never, surchargeCents: 0 }));

    const { params } = callArgs(create);
    expect(params.payment_method_types).toEqual(['pix']);
    const surcharge = (params.line_items ?? []).filter((li) =>
      li.price_data?.product_data?.name?.includes(SURCHARGE_LINE_ITEM_NAME),
    );
    expect(surcharge).toHaveLength(0);
  });

  it('credit_card → payment_method_types ["card"] and a distinct surcharge line item', async () => {
    const { stripe, create } = mockStripe();
    const provider = new PagamentoProviderStripe({ stripe, clock: () => new Date(0) });

    await provider.criarSessaoCheckout(
      baseInput({ metodo: 'credit_card' as never, surchargeCents: 350 }),
    );

    const { params } = callArgs(create);
    expect(params.payment_method_types).toEqual(['card']);
    const surcharge = (params.line_items ?? []).filter((li) =>
      li.price_data?.product_data?.name?.includes(SURCHARGE_LINE_ITEM_NAME),
    );
    expect(surcharge).toHaveLength(1);
    expect(surcharge[0]?.price_data?.unit_amount).toBe(350);
  });

  it('stamps the reserved engine metadata keys the webhook resolves payments by', async () => {
    const { stripe, create } = mockStripe();
    const provider = new PagamentoProviderStripe({ stripe, clock: () => new Date(0) });

    await provider.criarSessaoCheckout(baseInput());

    const { params } = callArgs(create);
    // idPagamento is the fallback key the webhook uses to resolve the pagamento
    // when the externalRef lookup misses — losing it silently breaks finalize.
    expect(params.metadata?.idPagamento).toBe('pag_contract_1');
    // The other reserved ids the webhook relies on to dispatch without a DB
    // re-resolve (see provider.stripe.ts metadata bag).
    expect(params.metadata?.idIntencaoPagamento).toBe('int_contract_1');
    expect(params.metadata?.idContribuicao).toBe('contrib_contract_1');
    expect(params.metadata?.idOpcaoContribuicao).toBe('opcao_contract_1');
    expect(params.metadata?.tipoOpcao).toBe('presente');
  });

  it('passes a deterministic idempotency key so a retried create never double-charges', async () => {
    const { stripe, create } = mockStripe();
    const provider = new PagamentoProviderStripe({ stripe, clock: () => new Date(0) });

    await provider.criarSessaoCheckout(baseInput({ idPagamento: 'pag_idem_9' as never }));

    const { options } = callArgs(create);
    expect(options.idempotencyKey).toBe('pagamento:pag_idem_9:create-session');
  });
});
