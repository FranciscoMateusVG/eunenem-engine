/**
 * Stripe webhook — checkout.session.completed PIX path (aperture-8ro9v #9).
 *
 * A `checkout.session.completed` event with payment_status='unpaid' (PIX) must
 * advance the matching PENDENTE pagamento to 'processing' (final 'aprovado'
 * arrives later via charge.succeeded) and the webhook must return 200 (no 500).
 *
 * Unlike the card path, the PIX path sets available_on inline (clock()) — no
 * payment_intent / provider lookup needed — so this seeds cleanly against the
 * dedicated :3003 Stripe-env server (see stripe-webhook-cartao.spec.ts header
 * for why :3003 exists). Signature computed manually via node:crypto.
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
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

test.describe('Stripe webhook — checkout.session.completed (PIX)', () => {
  test('unpaid PIX session advances the pendente pagamento to processing (200, no 500)', async ({
    request,
    seededData,
  }) => {
    const externalRef = `cs_test_${randomUUID().replace(/-/g, '')}`;

    const db = createDatabase(DATABASE_URL);
    let pagamentoId: string;
    try {
      const repos = buildSeedGiftRepos(db);
      const seeded = await seedPendentePagamento(repos, {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        nome: `Webhook PIX ${randomUUID().slice(0, 8)}`,
        valorCents: 5000,
        metodo: 'pix',
        externalRef,
      });
      pagamentoId = seeded.pagamentoId;
    } finally {
      await db.destroy();
    }

    const event = {
      id: `evt_test_${randomUUID().replace(/-/g, '')}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: externalRef,
          object: 'checkout.session',
          payment_status: 'unpaid', // PIX: paid later via charge.succeeded
          customer_details: { email: 'e2e-pix@test.local', name: 'E2E PIX Payer' },
          custom_fields: [{ key: 'nome', text: { value: 'E2E PIX Payer' } }],
        },
      },
    };
    const rawBody = JSON.stringify(event);
    const signature = signStripePayload(rawBody, WEBHOOK_SECRET);

    const res = await request.post(WEBHOOK_URL, {
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      data: rawBody,
    });

    // (1) 200 — not 500/400.
    expect(res.status(), `webhook should 200; body: ${await res.text()}`).toBe(200);

    // (2) PIX cs.completed advances pendente → processing (NOT aprovado yet).
    const db2 = createDatabase(DATABASE_URL);
    try {
      const repo = new PagamentoRepositoryPostgres(db2);
      const pagamento = await repo.findById(pagamentoId as never);
      expect(pagamento, 'pagamento should still exist').toBeTruthy();
      expect(
        (pagamento as { status: string }).status,
        'PIX checkout.session.completed should advance pendente → processing',
      ).toBe('processing');
    } finally {
      await db2.destroy();
    }
  });
});
