/**
 * Stripe webhook — checkout.session.completed CARTÃO path (aperture-8ro9v #8).
 *
 * A `checkout.session.completed` event with payment_status='paid' (card) must
 * advance the matching PENDENTE pagamento to 'aprovado' and the webhook must
 * return 200 (no 500).
 *
 * WHY A DEDICATED :3003 SERVER: the default :3002 e2e server runs with empty
 * STRIPE_* env (fake adapter, used by the visitor-cart test). The webhook needs
 * STRIPE_WEBHOOK_SECRET set to verify signatures — but setting it on :3002
 * would flip DI to the real Stripe provider and break the fake-adapter tests.
 * So this test targets a SEPARATE server on :3003 launched with a test
 * STRIPE_WEBHOOK_SECRET (+ a dummy STRIPE_SECRET_KEY — constructEvent is pure
 * local HMAC, no Stripe API call). The webhook payload OMITS payment_intent so
 * the card path never reaches the provider's available_on lookup.
 *
 * The signature is computed manually (Stripe's `t=<ts>,v1=<hmac>` scheme over
 * `<ts>.<rawBody>`) via node:crypto — no stripe package dependency from e2e/.
 */
import crypto, { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { PagamentoRepositoryPostgres } from '../src/adapters/pagamentos/repository.postgres.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedPendentePagamento } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const WEBHOOK_URL = 'http://localhost:3003/api/webhooks/stripe';
const WEBHOOK_SECRET = 'whsec_test_e2e_secret_for_signing_0000';

function signStripePayload(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const signed = `${ts}.${rawBody}`;
  const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${ts},v1=${sig}`;
}

test.describe('Stripe webhook — checkout.session.completed (cartão)', () => {
  // FIXED (aperture-07x5c). Root cause was NOT the availableOn path: finalize
  // → aprovarPagamento → pagamentoProvider.solicitarPagamento() calls
  // stripe.checkout.sessions.retrieve(externalRef) to re-confirm the session,
  // a REAL Stripe API call that 500s on the :3003 dummy key. The persisted
  // balanceTransactionAvailableOn is read persisted-first downstream and was
  // never the problem. Fix: the :3003 server now runs with
  // E2E_FAKE_PAGAMENTO_PROVIDER=1 — a NODE_ENV!=production-guarded, defaults-off
  // DI seam that forces the deterministic fake PagamentoProvider while keeping
  // getStripe() alive for the pure-HMAC constructEvent signature verification.
  // So the webhook signature is still verified for real; only the settlement
  // round-trip (which needs a live Stripe account) is stubbed.
  test('paid card session advances the pendente pagamento to aprovado (200, no 500)', async ({
    request,
    seededData,
  }) => {
    const externalRef = `cs_test_${randomUUID().replace(/-/g, '')}`;

    // Seed a PENDENTE credit_card pagamento findable by externalRef.
    const db = createDatabase(DATABASE_URL);
    let pagamentoId: string;
    try {
      const repos = buildSeedGiftRepos(db);
      const seeded = await seedPendentePagamento(repos, {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: `Webhook Cartao ${randomUUID().slice(0, 8)}`,
        valorCents: 5000,
        metodo: 'credit_card',
        externalRef,
        // Card finalize builds a financeiro lançamento off this — seed it
        // non-null so the dispatch reaches 'aprovado' instead of throwing.
        balanceTransactionAvailableOn: new Date(),
      });
      pagamentoId = seeded.pagamentoId;
    } finally {
      await db.destroy();
    }

    // Build a checkout.session.completed event. payment_intent is OMITTED so
    // the card path never calls the provider's available_on lookup.
    const event = {
      id: `evt_test_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: externalRef,
          object: 'checkout.session',
          payment_status: 'paid',
          customer_details: { email: 'e2e-card@test.local', name: 'E2E Card Payer' },
          custom_fields: [{ key: 'nome', text: { value: 'E2E Card Payer' } }],
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const signature = signStripePayload(rawBody, WEBHOOK_SECRET);

    // POST the signed webhook to the dedicated :3003 server.
    const res = await request.post(WEBHOOK_URL, {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      data: rawBody,
    });

    // (1) 200 — NOT 500 (the scenario's core assertion) and NOT 400 (sig ok).
    expect(res.status(), `webhook should 200; body: ${await res.text()}`).toBe(200);

    // (2) the pendente pagamento flipped to aprovado.
    const db2 = createDatabase(DATABASE_URL);
    try {
      const repo = new PagamentoRepositoryPostgres(db2);
      const pagamento = await repo.findById(pagamentoId as never);
      expect(pagamento, 'pagamento should still exist').toBeTruthy();
      expect(
        (pagamento as { status: string }).status,
        'card checkout.session.completed should advance pendente → aprovado',
      ).toBe('aprovado');
    } finally {
      await db2.destroy();
    }
  });
});
