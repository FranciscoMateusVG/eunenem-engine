/**
 * aperture-a4pqt — literal no-webhook PIX expiry through the production worker.
 *
 * This is deliberately not a use-case test. It creates the charge through the
 * :3004 visitor UI, advances only that owned payment's persisted expiry, sends
 * the real pg-boss queue, and waits for the already-running composition-root
 * worker to persist the terminal provider truth.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
// eslint-disable-next-line import/no-relative-packages
import { PgBoss } from '../apps/eunenem-server/node_modules/pg-boss/dist/index.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedAvailableGift } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
const PIX_SERVER = 'http://localhost:3004';
const PIX_QUEUE = 'pix-cobranca-reconciliation-v1';
const OWNER_EMAIL = `a4pqt-expiry-${randomUUID()}@e2e.local`;

interface PaymentRow {
  readonly id: string;
  readonly status: string;
  readonly intencao_external_ref: string | null;
  readonly intencao_expira_em: Date | string | null;
  readonly transacao_externa_text: string | null;
}

interface JobRow {
  readonly state: string;
  readonly started_on: Date | null;
  readonly completed_on: Date | null;
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await read();
  }
  expect(accept(latest), `${message}; latest=${JSON.stringify(latest)}`).toBe(true);
  return latest;
}

async function paymentByOwner(db: Database): Promise<PaymentRow | undefined> {
  const result = await sql<PaymentRow>`
    SELECT id, status, intencao_external_ref, intencao_expira_em,
           transacao_externa::text AS transacao_externa_text
     FROM pagamentos
     WHERE intencao_contribuinte_email = ${OWNER_EMAIL}
     ORDER BY intencao_criada_em DESC
     LIMIT 1
  `.execute(db);
  return result.rows[0];
}

async function openPixCheckout(page: Page, slug: string, giftName: string): Promise<string> {
  // PixCheckout polls this read immediately after the QR appears. Keep that
  // display-only query from consuming the fake provider's authoritative first
  // consult: the pg-boss worker below must be the first real provider reader.
  await page.route(/obterStatusPix/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ result: { data: { status: 'pendente' } } }]),
    });
  });

  const config = page.waitForResponse((response) => response.url().includes('obterConfigCheckout'));
  await page.goto(`${PIX_SERVER}/pagina/${slug}`);
  const card = page.locator('article').filter({ hasText: giftName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /\+ Adicionar/i }).click();
  const cart = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  await cart.getByRole('button', { name: 'Fechar carrinho' }).click();
  await card.getByRole('button', { name: /ou comprar agora/ }).click();

  const modal = page.locator('[role="dialog"][aria-labelledby="gift-checkout-title"]');
  const pix = modal.getByRole('radio', { name: /^Pix/ });
  await pix.click();
  await config;
  await modal.getByRole('button', { name: 'Continuar →' }).click();
  await modal.getByPlaceholder('Ana & João').fill('A4PQT Expiry Walker');
  await modal.getByPlaceholder('ana@email.com').fill(OWNER_EMAIL);
  await modal.getByPlaceholder('a gente já te ama tanto ♡').fill('sem webhook');

  const initiated = page.waitForResponse(
    (response) =>
      response.url().includes('iniciarPagamentoContribuicao') &&
      response.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();
  const response = await initiated;
  const responseText = await response.text();
  expect(response.status(), responseText).toBe(200);
  const body = JSON.parse(responseText) as Array<{
    result?: { data?: { txid?: string; valorCents?: number } };
  }>;
  expect(body[0]?.result?.data?.valorCents).toBe(1404);
  const txid = body[0]?.result?.data?.txid;
  expect(txid).toMatch(/^[a-f0-9]{32}$/);
  await expect(
    modal.locator('canvas[role="img"][aria-label="QR code do pagamento pix"]'),
  ).toBeVisible();
  return txid as string;
}

async function cleanupOwned(
  db: Database,
  contributionId: string | undefined,
  jobIds: readonly string[],
): Promise<void> {
  const owned = await sql<{ id: string }>`
    SELECT id FROM pagamentos WHERE intencao_contribuinte_email = ${OWNER_EMAIL}
  `.execute(db);
  for (const row of owned.rows) {
    await sql`DELETE FROM payment_webhook_events WHERE pagamento_id = ${row.id}`.execute(db);
    await sql`DELETE FROM pix_cobranca_devolucoes WHERE id_pagamento = ${row.id}`.execute(db);
    await sql`DELETE FROM lancamentos_financeiros WHERE id_pagamento = ${row.id}`.execute(db);
    await sql`DELETE FROM pagamentos WHERE id = ${row.id}`.execute(db);
  }
  if (contributionId) {
    await sql`DELETE FROM contribuicoes WHERE id = ${contributionId}`.execute(db);
  }
  for (const jobId of jobIds) {
    await sql`DELETE FROM pgboss.job WHERE id = ${jobId} AND name = ${PIX_QUEUE}`.execute(db);
  }
}

test('checkout → no webhook → real pg-boss expiry worker persists REMOVIDA rejection', async ({
  page,
  seededData,
}) => {
  test.setTimeout(90_000);
  const db = createDatabase(DATABASE_URL);
  const boss = new PgBoss(DATABASE_URL);
  const jobIds: string[] = [];
  let contributionId: string | undefined;
  boss.on('error', () => undefined);

  try {
    const queue = await sql<{ queue_count: number; schedule_count: number }>`
      SELECT
        (SELECT count(*)::int FROM pgboss.queue WHERE name = ${PIX_QUEUE}) AS queue_count,
        (SELECT count(*)::int FROM pgboss.schedule WHERE name = ${PIX_QUEUE}) AS schedule_count
    `.execute(db);
    expect(queue.rows[0]?.queue_count, 'composition root must create the expiry queue').toBe(1);
    expect(
      queue.rows[0]?.schedule_count,
      'composition root must register the 5-minute schedule',
    ).toBe(1);

    contributionId = await seedAvailableGift(buildSeedGiftRepos(db), {
      idCampanha: seededData.idCampanha,
      idOpcaoPresentes: seededData.idOpcaoPresentes,
      nome: `A4PQT Expiry ${randomUUID().slice(0, 8)}`,
      // 1288 + ceil(8.98%) = 1404, the fake's authoritative REMOVIDA outcome.
      valorCents: 1288,
    });
    const giftName = (
      await sql<{
        nome: string;
      }>`SELECT nome FROM contribuicoes WHERE id = ${contributionId}`.execute(db)
    ).rows[0]?.nome;
    expect(giftName).toBeTruthy();

    const txid = await openPixCheckout(page, seededData.slug, giftName as string);
    const persisted = await paymentByOwner(db);
    expect(persisted?.status).toBe('pendente');
    expect(persisted?.intencao_external_ref).toBe(txid);
    expect(txid).toBe(persisted?.id.replaceAll('-', ''));
    expect(new Date(persisted?.intencao_expira_em ?? 0).getTime()).toBeGreaterThan(Date.now());

    // Test-only clock acceleration is scoped to the exact browser-created row.
    await sql`
      UPDATE pagamentos
         SET intencao_expira_em = now() - interval '1 minute',
             pix_reconciliacao_claimed_until = NULL
       WHERE id = ${persisted?.id}
         AND intencao_external_ref = ${txid}
         AND intencao_contribuinte_email = ${OWNER_EMAIL}
    `.execute(db);

    await boss.start();
    // Three Playwright composition roots share the database; only :3004 owns
    // the fake PIX provider. Re-send after a completed no-op job until that
    // correctly configured real worker consumes one. Every attempt remains a
    // real pg-boss dispatch; the bound is a loud substrate-health assertion.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const jobId = await boss.send(PIX_QUEUE, { schemaVersion: 1 });
      expect(jobId, 'pg-boss must accept the reconciliation job').toBeTruthy();
      jobIds.push(jobId as string);
      await eventually(
        async () => {
          const result = await sql<JobRow>`
            SELECT state, started_on, completed_on FROM pgboss.job WHERE id = ${jobId}
          `.execute(db);
          return result.rows[0];
        },
        (job) => job?.state === 'completed',
        'expiry job did not complete: composition-root worker absent or unregistered',
      );
      const current = await paymentByOwner(db);
      if (current?.status === 'rejeitado') break;
    }

    const terminal = await eventually(
      () => paymentByOwner(db),
      (row) => row?.status === 'rejeitado',
      'no registered :3004 composition-root worker produced the terminal expiry transition',
    );
    expect(terminal?.id).toBe(persisted?.id);
    expect(terminal?.intencao_external_ref).toBe(txid);
    const transacao = JSON.parse(terminal?.transacao_externa_text ?? 'null') as {
      id?: string;
      provedor?: string;
      status?: string;
      amountCents?: number;
      statusBruto?: string;
    } | null;
    expect(transacao).toMatchObject({
      id: txid,
      provedor: 'inter',
      status: 'rejeitado',
      amountCents: 1404,
      statusBruto: 'REMOVIDA',
    });

    // Negative-space proof for the acceptance criterion: this payment became
    // terminal through the scheduled worker alone. No webhook archive exists
    // for the browser-created payment.
    const webhookArchive = await sql<{ count: number }>`
      SELECT count(*)::int AS count
        FROM payment_webhook_events
       WHERE pagamento_id = ${persisted?.id}
    `.execute(db);
    expect(webhookArchive.rows[0]?.count).toBe(0);

    const completed = await sql<{ completed: number; started: number }>`
      SELECT count(*) FILTER (WHERE state = 'completed')::int AS completed,
             count(*) FILTER (WHERE started_on IS NOT NULL)::int AS started
        FROM pgboss.job
       WHERE id = ANY(${sql.val(jobIds)}::uuid[])
         AND name = ${PIX_QUEUE}
    `.execute(db);
    expect(completed.rows[0]?.completed).toBeGreaterThan(0);
    expect(completed.rows[0]?.started).toBeGreaterThan(0);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await cleanupOwned(db, contributionId, jobIds);
    await db.destroy();
  }
});
