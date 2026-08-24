/**
 * aperture-a4pqt — literal refund journeys through the production-shaped UI.
 *
 * Inter walk (dedicated fake-cobrança server on :3004):
 *   visitor checkout → identity form → QR → real Inter webhook route
 *   → approved payment → admin detail → ack-gated refund →
 *   pending truth strip → real refund webhook route → terminal UI + DB.
 *
 * The fake's identities deliberately mirror Banco Inter's contracts:
 *   txid = payment UUID without hyphens; e2eId = the same full txid.
 * That makes the browser-created payment eligible for the real durable claim,
 * verify-by-requery and binding checks. No direct SQL promotion is used.
 *
 * Historical Stripe remains a direct fixture because such rows pre-date a
 * provider transaction. It still walks the same admin CTA/dialog and proves
 * the synchronous settled truth strip.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import {
  buildSeedGiftRepos,
  seedAvailableGift,
  seedMultiItemApprovedPagamento,
} from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const PIX_SERVER = 'http://localhost:3004';
const OWNER_EMAIL = `a4pqt-${randomUUID()}@e2e.local`;
const INJECTED_PAYER_NAME = 'A4PQT Archive Payer';
const INJECTED_PAYER_CPF = '12345678901';
const INJECTED_PAYER_EMAIL = 'must-not-enter-the-archive@e2e.local';
const INJECTED_EXTRA_FIELD = 'drop-a4pqt-extra';
const MAX_ARCHIVED_PROJECTION_BYTES = 128;

interface CheckoutIdentity {
  readonly pagamentoId: string;
  readonly txid: string;
  readonly e2eId: string;
  readonly contributionId: string;
}

interface RefundRecord {
  readonly e2e_id: string;
  readonly id_devolucao: string;
  readonly amount_cents: string | number | bigint;
  readonly status: string;
}

interface ArchiveRow {
  readonly processed_at: Date | null;
  readonly processing_error: string | null;
  readonly pagamento_id: string | null;
  readonly raw_payload: unknown;
  readonly raw_payload_bytes: number;
}

interface LedgerCascadeRow {
  readonly total: number;
  readonly cancelled: number;
  readonly transferred: number;
}

async function seedWebhookGift(
  db: Database,
  seed: { idCampanha: string; idOpcaoPresentes: string },
): Promise<{ id: string; nome: string }> {
  // Gift 1273 + ceil(5% fee) = 1337. The e2e-only fake therefore returns
  // `concluida` when the unsigned callback triggers its authoritative read.
  const nome = `A4PQT Inter ${randomUUID().slice(0, 8)}`;
  const id = await seedAvailableGift(buildSeedGiftRepos(db), {
    idCampanha: seed.idCampanha,
    idOpcaoPresentes: seed.idOpcaoPresentes,
    nome,
    valorCents: 1273,
  });
  return { id, nome };
}

async function openSingleGiftPixCheckout(page: Page, slug: string, giftName: string) {
  const config = page.waitForResponse((response) => response.url().includes('obterConfigCheckout'));
  await page.goto(`${PIX_SERVER}/pagina/${slug}`);

  const card = page.locator('article').filter({ hasText: giftName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /\+ Adicionar/i }).click();

  const cart = page.locator('[role="dialog"][aria-labelledby="cart-drawer-title"]');
  await expect(cart).toBeVisible();
  await cart.getByRole('button', { name: 'Fechar carrinho' }).click();
  await expect(cart).toBeHidden();

  await card.getByRole('button', { name: /ou comprar agora/ }).click();
  const modal = page.locator('[role="dialog"][aria-labelledby="gift-checkout-title"]');
  await expect(modal).toBeVisible();
  const pix = modal.getByRole('radio', { name: /^Pix/ });
  await pix.click();
  await expect(pix).toHaveAttribute('aria-checked', 'true');
  await config;
  await modal.getByRole('button', { name: 'Continuar →' }).click();
  await expect(modal.getByRole('heading', { name: 'de quem vem esse carinho?' })).toBeVisible();
  return modal;
}

async function completePixIdentity(page: Page, modal: ReturnType<Page['locator']>) {
  await modal.getByPlaceholder('Ana & João').fill('A4PQT Visitante Inter');
  await modal.getByPlaceholder('ana@email.com').fill(OWNER_EMAIL);
  await modal.getByPlaceholder('a gente já te ama tanto ♡').fill('fluxo literal de estorno');

  const initiated = page.waitForResponse(
    (response) =>
      response.url().includes('iniciarPagamentoContribuicao') &&
      response.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'continuar para o pix ♡' }).click();
  const response = await initiated;
  expect(response.status()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);

  const body = JSON.parse(await response.text()) as Array<{
    result?: { data?: { txid?: string; valorCents?: number } };
  }>;
  const txid = body[0]?.result?.data?.txid;
  expect(txid, 'checkout must return its Inter-shaped txid').toMatch(/^[a-f0-9]{32}$/);
  expect(body[0]?.result?.data?.valorCents).toBe(1337);
  await expect(
    modal.locator('canvas[role="img"][aria-label="QR code do pagamento pix"]'),
  ).toBeVisible();
  return txid as string;
}

async function checkoutIdentity(
  db: Database,
  page: Page,
  slug: string,
  gift: { id: string; nome: string },
): Promise<CheckoutIdentity> {
  const modal = await openSingleGiftPixCheckout(page, slug, gift.nome);
  const txid = await completePixIdentity(page, modal);
  const row = await sql<{ id: string }>`
    SELECT id FROM pagamentos
     WHERE intencao_external_ref = ${txid}
       AND intencao_contribuinte_email = ${OWNER_EMAIL}
  `.execute(db);
  const pagamentoId = row.rows[0]?.id;
  expect(pagamentoId, 'browser checkout must persist the payment').toBeTruthy();
  expect(txid).toBe(pagamentoId?.replaceAll('-', ''));
  return {
    pagamentoId: pagamentoId as string,
    txid,
    e2eId: txid,
    contributionId: gift.id,
  };
}

async function postInterWebhook(page: Page, body: unknown): Promise<void> {
  const response = await page.request.post(`${PIX_SERVER}/api/webhooks/inter/pix`, {
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function walkToArmedRefund(page: Page, idCampanha: string, pagamentoId: string) {
  // Follow the same discovery path an operator uses: campanha payment list →
  // payment detail. A direct detail-page goto would miss a broken/missing
  // campaign-row link while still letting the refund dialog test pass.
  await page.goto(`${PIX_SERVER}/admin/campanha/${idCampanha}`);
  const paymentLink = page.locator(`a[href="/admin/pagamento/${pagamentoId}"]`);
  await expect(paymentLink).toBeVisible();
  await paymentLink.click();
  await expect(page).toHaveURL(`${PIX_SERVER}/admin/pagamento/${pagamentoId}`);

  const block = page.getByTestId('estorno-block');
  await expect(block).toBeVisible();
  await block.getByRole('button', { name: 'estornar pagamento' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirmar estorno de pagamento' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'confirmar estorno' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();
  return { block, dialog, confirm };
}

async function pagamentoStatus(db: Database, pagamentoId: string): Promise<string | undefined> {
  const row = await sql<{ status: string }>`
    SELECT status FROM pagamentos WHERE id = ${pagamentoId}
  `.execute(db);
  return row.rows[0]?.status;
}

async function refundRecord(db: Database, pagamentoId: string): Promise<RefundRecord | undefined> {
  const row = await sql<RefundRecord>`
    SELECT e2e_id, id_devolucao, amount_cents, status
      FROM pix_cobranca_devolucoes
     WHERE id_pagamento = ${pagamentoId}
  `.execute(db);
  return row.rows[0];
}

function expectExactArchiveProjection(
  row: ArchiveRow | undefined,
  expectedProjection: Record<string, string>,
  label: string,
): void {
  expect(row, `${label} archive row must exist`).toBeDefined();
  if (!row) throw new Error(`${label}_archive_missing`);

  // raw_payload is JSONB: transport whitespace, key order and duplicate keys
  // are intentionally not a persistence contract. Assert the exact semantic
  // projection (including the exact key set) instead of pretending the DB can
  // reproduce request bytes. The byte count remains a bounded serialized-
  // projection guard.
  expect(
    row.raw_payload,
    `${label} must persist only the exact bounded PII-free routing projection`,
  ).toStrictEqual(expectedProjection);
  expect(row.raw_payload_bytes).toBeLessThanOrEqual(MAX_ARCHIVED_PROJECTION_BYTES);

  const serializedProjection = Buffer.from(JSON.stringify(row.raw_payload), 'utf8');
  for (const forbidden of [
    INJECTED_PAYER_NAME,
    INJECTED_PAYER_CPF,
    INJECTED_PAYER_EMAIL,
    INJECTED_EXTRA_FIELD,
  ]) {
    expect(
      serializedProjection.includes(Buffer.from(forbidden, 'utf8')),
      `${label} archive must strip injected payer/extra field ${forbidden}`,
    ).toBe(false);
  }
}

async function readLedgerCascade(db: Database, pagamentoId: string): Promise<LedgerCascadeRow> {
  const result = await sql<LedgerCascadeRow>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE cancelado_em IS NOT NULL)::int AS cancelled,
           count(*) FILTER (WHERE transferido_em IS NOT NULL)::int AS transferred
      FROM lancamentos_financeiros
     WHERE id_pagamento = ${pagamentoId}
  `.execute(db);
  const ledger = result.rows[0];
  if (!ledger) throw new Error(`ledger_cascade_missing:${pagamentoId}`);
  return ledger;
}

function expectApprovedLedger(ledger: LedgerCascadeRow): void {
  // This one-item fixture creates exactly the receiver principal and platform
  // fee rows. Locking cardinality prevents a duplicate/missing ledger effect
  // from hiding behind a merely non-empty terminal snapshot.
  expect(ledger.total, 'approved Inter payment must create both Financeiro ledger rows').toBe(2);
  expect(ledger.cancelled).toBe(0);
  expect(ledger.transferred).toBe(0);
}

function expectRefundedLedger(ledger: LedgerCascadeRow, approvedTotal: number): void {
  expect(ledger.total).toBe(approvedTotal);
  expect(ledger.cancelled).toBe(ledger.total);
  expect(ledger.transferred).toBe(0);
}

async function cleanupOwned(
  db: Database,
  args: {
    paymentIds: readonly string[];
    contributionIds: readonly string[];
    providerEventIds: readonly string[];
  },
): Promise<void> {
  // A checkout can fail an assertion after persisting the payment but before
  // checkoutIdentity returns its id. Recover those partial rows by this
  // spec's unique owner email so cleanup cannot mask the original failure.
  const partialPayments = await sql<{ id: string }>`
    SELECT id FROM pagamentos
     WHERE intencao_contribuinte_email = ${OWNER_EMAIL}
  `.execute(db);
  const ownedPaymentIds = new Set([
    ...args.paymentIds,
    ...partialPayments.rows.map((row) => row.id),
  ]);

  // A failed dispatch can leave an archive row unlinked (pagamento_id NULL).
  // Delete the exact immutable identities too, otherwise the next run takes
  // a duplicate/retry path instead of exercising first-attempt composition.
  for (const providerEventId of args.providerEventIds) {
    await sql`
      DELETE FROM payment_webhook_events
       WHERE provider = 'inter'
         AND provider_event_id = ${providerEventId}
    `.execute(db);
  }

  for (const pagamentoId of ownedPaymentIds) {
    await sql`DELETE FROM payment_webhook_events WHERE pagamento_id = ${pagamentoId}`.execute(db);
    await sql`DELETE FROM pix_cobranca_devolucoes WHERE id_pagamento = ${pagamentoId}`.execute(db);
    await sql`DELETE FROM lancamentos_financeiros WHERE id_pagamento = ${pagamentoId}`.execute(db);
    await sql`DELETE FROM pagamentos WHERE id = ${pagamentoId}`.execute(db);
  }
  for (const contributionId of args.contributionIds) {
    await sql`DELETE FROM contribuicoes WHERE id = ${contributionId}`.execute(db);
  }
}

test.describe('a4pqt — literal admin refund journeys', () => {
  test('Inter: checkout + charge webhook → pending refund → refund webhook → terminal UI and archive', async ({
    page,
    adminAuthenticatedPage: admin,
    seededData,
  }) => {
    test.setTimeout(60_000);
    const db = createDatabase(DATABASE_URL);
    const paymentIds: string[] = [];
    const contributionIds: string[] = [];
    const providerEventIds: string[] = [];
    try {
      const gift = await seedWebhookGift(db, seededData);
      contributionIds.push(gift.id);
      const identity = await checkoutIdentity(db, page, seededData.slug, gift);
      paymentIds.push(identity.pagamentoId);

      // Actual unsigned Inter callback route: the payload is only a routing
      // hint. The server must bind txid, re-query the fake provider, and write
      // the authoritative e2e transaction before approving.
      const chargeProviderEventId = `${identity.txid}:${identity.e2eId}`;
      providerEventIds.push(chargeProviderEventId);
      await postInterWebhook(page, {
        pix: [
          {
            txid: identity.txid,
            endToEndId: identity.e2eId,
            pagador: {
              nome: INJECTED_PAYER_NAME,
              cpf: INJECTED_PAYER_CPF,
              email: INJECTED_PAYER_EMAIL,
            },
            extraWebhookField: INJECTED_EXTRA_FIELD,
          },
        ],
      });
      await expect
        .poll(() => pagamentoStatus(db, identity.pagamentoId), {
          timeout: 15_000,
          intervals: [100, 200, 500],
        })
        .toBe('aprovado');

      // User-visible completion is part of the literal journey, not merely
      // a DB side effect: the same visitor modal must poll the approved
      // payment and replace the QR screen with its confirmation surface.
      await expect(page.getByText('recebemos seu carinho ♡')).toBeVisible({
        timeout: 10_000,
      });

      const approved = await sql<{
        e2e_ref: string | null;
        tx: { id?: string; provedor?: string; amountCents?: number } | null;
        total: string | number | bigint;
      }>`
        SELECT intencao_e2e_external_ref AS e2e_ref,
               transacao_externa AS tx,
               intencao_total_paid_cents AS total
          FROM pagamentos WHERE id = ${identity.pagamentoId}
      `.execute(db);
      expect(approved.rows[0]?.e2e_ref).toBe(identity.e2eId);
      expect(approved.rows[0]?.tx).toMatchObject({
        id: identity.e2eId,
        provedor: 'inter',
        amountCents: 1337,
      });
      const approvedLedger = await readLedgerCascade(db, identity.pagamentoId);
      expectApprovedLedger(approvedLedger);

      const { dialog, confirm } = await walkToArmedRefund(
        admin,
        seededData.idCampanha,
        identity.pagamentoId,
      );
      // Reason belongs only to Stripe. Inter collects no provider reason.
      await expect(dialog.getByRole('combobox')).toHaveCount(0);
      await expect(dialog.getByText(/devolução PIX \(Inter\)/i)).toBeVisible();
      await confirm.click();
      await expect(dialog).toBeHidden();

      const strip = admin.getByTestId('estorno-result');
      await expect(strip).toHaveText(/estorno solicitado — aguardando o banco/i);
      await expect(admin.getByText('devolução em processamento')).toBeVisible();

      const pending = await refundRecord(db, identity.pagamentoId);
      expect(pending).toMatchObject({
        e2e_id: identity.e2eId,
        id_devolucao: identity.pagamentoId.replaceAll('-', ''),
        status: 'em_processamento',
      });
      if (!pending) throw new Error('inter_refund_record_missing');
      expect(Number(pending?.amount_cents)).toBe(Number(approved.rows[0]?.total));
      expect(await pagamentoStatus(db, identity.pagamentoId)).toBe('aprovado');

      // Actual refund webhook payload. The callback does NOT trust its body:
      // it resolves the persisted amount, re-queries the provider, then runs
      // provider-free bookkeeping through the exact composite identity.
      const refundProviderEventId = `${identity.e2eId}:devolucao:${pending.id_devolucao}`;
      providerEventIds.push(refundProviderEventId);
      await postInterWebhook(page, {
        pix: [
          {
            txid: identity.txid,
            endToEndId: identity.e2eId,
            devolucoes: [
              {
                id: pending.id_devolucao,
                motivo: INJECTED_EXTRA_FIELD,
                pagador: { nome: INJECTED_PAYER_NAME, cpf: INJECTED_PAYER_CPF },
              },
            ],
            extraWebhookField: INJECTED_EXTRA_FIELD,
          },
        ],
      });

      await expect
        .poll(() => pagamentoStatus(db, identity.pagamentoId), {
          timeout: 20_000,
          intervals: [100, 200, 500, 1000],
        })
        .toBe('estornado');
      await expect
        .poll(async () => (await refundRecord(db, identity.pagamentoId))?.status, {
          timeout: 20_000,
          intervals: [100, 200, 500, 1000],
        })
        .toBe('devolvida');

      // The UI's 3s poll converges to terminal truth without a manual reload.
      await expect(strip).toHaveText(/pagamento estornado/i, { timeout: 12_000 });
      await expect(admin.getByText('devolução concluída')).toBeVisible({ timeout: 12_000 });
      await expect(strip).not.toHaveText(/aguardando o banco/i);
      expectRefundedLedger(await readLedgerCascade(db, identity.pagamentoId), approvedLedger.total);

      const chargeArchive = await sql<ArchiveRow>`
        SELECT processed_at, processing_error, pagamento_id,
               raw_payload,
               octet_length(raw_payload::text) AS raw_payload_bytes
          FROM payment_webhook_events
         WHERE provider = 'inter'
           AND provider_event_id = ${chargeProviderEventId}
      `.execute(db);
      expect(chargeArchive.rows[0]).toMatchObject({
        processing_error: null,
        pagamento_id: identity.pagamentoId,
      });
      expect(chargeArchive.rows[0]?.processed_at).not.toBeNull();
      expectExactArchiveProjection(
        chargeArchive.rows[0],
        { txid: identity.txid, endToEndId: identity.e2eId },
        'charge',
      );

      const refundArchive = await sql<ArchiveRow>`
        SELECT processed_at, processing_error, pagamento_id,
               raw_payload,
               octet_length(raw_payload::text) AS raw_payload_bytes
          FROM payment_webhook_events
         WHERE provider = 'inter'
           AND provider_event_id = ${refundProviderEventId}
      `.execute(db);
      expect(refundArchive.rows[0]).toMatchObject({
        processing_error: null,
        pagamento_id: identity.pagamentoId,
      });
      expect(refundArchive.rows[0]?.processed_at).not.toBeNull();
      expectExactArchiveProjection(
        refundArchive.rows[0],
        { endToEndId: identity.e2eId, idDevolucao: pending.id_devolucao },
        'refund',
      );
    } finally {
      await cleanupOwned(db, { paymentIds, contributionIds, providerEventIds });
      await db.destroy();
    }
  });

  test('historical Stripe: same admin UI shows reason and settles synchronously', async ({
    adminAuthenticatedPage: admin,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    const paymentIds: string[] = [];
    const contributionIds: string[] = [];
    try {
      const seeded = await seedMultiItemApprovedPagamento(buildSeedGiftRepos(db), {
        idCampanha: seededData.idCampanha,
        idOpcaoPresentes: seededData.idOpcaoPresentes,
        items: [{ nome: `A4PQT Stripe ${randomUUID().slice(0, 8)}`, valorCents: 5000 }],
      });
      paymentIds.push(seeded.pagamentoId);
      contributionIds.push(...seeded.contribuicaoIds);

      const { dialog, confirm } = await walkToArmedRefund(
        admin,
        seededData.idCampanha,
        seeded.pagamentoId,
      );
      const reason = dialog.getByRole('combobox');
      await expect(reason).toBeVisible();
      await reason.selectOption('requested_by_customer');
      await confirm.click();
      await expect(dialog).toBeHidden();
      await expect(admin.getByTestId('estorno-result')).toHaveText(/pagamento estornado/i);
      await expect
        .poll(() => pagamentoStatus(db, seeded.pagamentoId), {
          timeout: 15_000,
          intervals: [100, 200, 500],
        })
        .toBe('estornado');
      expect(await refundRecord(db, seeded.pagamentoId)).toBeUndefined();
    } finally {
      await cleanupOwned(db, { paymentIds, contributionIds, providerEventIds: [] });
      await db.destroy();
    }
  });
});
